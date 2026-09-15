import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import base64

spec = importlib.util.spec_from_file_location("judge", Path(__file__).with_name("online-mind2web-judge.py"))
judge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(judge)


class JudgeEvidenceTests(unittest.TestCase):
    def test_script_answers_are_separate_claims_and_do_not_change_the_reference_protocol(self):
        def messages():
            return [{"role": "system", "content": "rubric"}, {"role": "user", "content": [{"type": "text", "text": "Action History: recorded facts"}]}]
        original = messages()
        _, text = judge.include_candidate_answer({"schema_version": "online-mind2web-v2", "agent_final_answer": "claim"}, original, "Action History: recorded facts")
        self.assertNotIn("claim", text)
        expanded, text = judge.include_candidate_answer({"schema_version": "rome-mind2web-tools-v1", "agent_final_answer": "claim"}, messages(), "Action History: recorded facts")
        self.assertIn("Candidate final answer (an untrusted claim", text)
        self.assertIn("answer alone cannot prove completion", text)
        self.assertEqual(expanded[1]["content"][0]["text"], text)

    def test_rome_images_are_attached_and_not_given_as_remote_urls(self):
        raw = base64.b64encode(b"\xff\xd8image").decode()
        payload = judge.rome_input([{"role": "system", "content": "Judge only evidence"},
                                    {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64," + raw}}]}])
        self.assertEqual(payload["files"][0]["mimeType"], "image/jpeg")
        self.assertEqual(payload["files"][0]["dataBase64"], raw)
        self.assertIn("Judge only evidence", payload["text"])
        with self.assertRaises(ValueError):
            judge.rome_input([{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "https://example.com/image.png"}}]}])

    def test_rome_judge_rejects_tool_use_and_wrong_provider(self):
        trace = [{"type": "result", "content": "Status: success", "accounting": {"provider": "openai"}},
                 {"type": "turn_end", "turnId": "turn", "status": "completed"}]
        self.assertEqual(judge.rome_answer(trace, "turn"), "Status: success")
        with self.assertRaises(ValueError):
            judge.rome_answer(trace + [{"type": "tool_use", "tool": "Read"}], "turn")
        trace[0]["accounting"]["provider"] = "anthropic"
        with self.assertRaises(ValueError):
            judge.rome_answer(trace, "turn")

    def test_rome_judge_uses_a_fresh_non_main_session_per_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            model = judge.RomeJudgeModel("model", 1, "http://127.0.0.1:4141/api", temporary)
            calls = []
            def request(path, body=None):
                calls.append((path, body))
                if path == "/chat/sessions":
                    return {"id": body["name"], "agentName": "core:online-mind2web-judge", "largeModelSelection": "model"}
                if path.endswith("trace.json"):
                    return [{"type": "result", "content": "Status: success", "accounting": {"provider": "openai"}},
                            {"type": "turn_end", "turnId": "turn", "status": "completed"}]
                if body is not None:
                    return {"turnId": "turn"}
                return []
            model.request = request
            for _ in range(2):
                self.assertEqual(model.generate([{"role": "user", "content": "Grade this"}]), ["Status: success"])
            created = [body for path, body in calls if path == "/chat/sessions"]
            self.assertNotEqual(created[0]["projectPath"], created[1]["projectPath"])
            self.assertEqual(created[0]["agentName"], "core:online-mind2web-judge")
            self.assertEqual(len(list(Path(temporary).glob("*.json"))), 2)

    def test_lost_rome_submission_stops_judging(self):
        with tempfile.TemporaryDirectory() as temporary:
            model = judge.RomeJudgeModel("model", 1, "http://127.0.0.1:4141/api", temporary)
            def request(path, body=None):
                if path == "/chat/sessions":
                    return {"id": "session", "agentName": "online-mind2web-judge", "largeModelSelection": "model"}
                raise TimeoutError("Lost response")
            model.request = request
            with self.assertRaises(judge.JudgeStopRequired):
                model.generate([{"role": "user", "content": "Grade this"}])
            log = json.loads(next(Path(temporary).glob("*.json")).read_text())
            self.assertEqual(log["status"], "cancellation_unconfirmed")

    def test_verdict_requires_an_unambiguous_status_line(self):
        self.assertEqual(judge.verdict('Thoughts: Evidence matches.\nStatus: "success"'), 1)
        self.assertEqual(judge.verdict("Thoughts: The action succeeded, but the task failed.\nStatus: failure"), 0)
        for response in ["success", "Status: unsuccessful", "Status: success\nStatus: failure"]:
            with self.assertRaises(ValueError):
                judge.verdict(response)

    def test_final_claim_is_excluded_and_images_are_fingerprinted(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            directory = run / "tasks" / "fixture"
            (directory / "trajectory").mkdir(parents=True)
            steps = [
                {"step": 0, "screenshot": "0000.png", "action": "page -> WAIT -> inspect"},
                {"step": 1, "screenshot": "0001.png", "action": "TASK_COMPLETE -> ANSWER: unsupported claim"},
            ]
            result = {"schema_version": "online-mind2web-v2", "task_id": "fixture", "action_history": steps}
            (directory / "result.json").write_text(json.dumps(result))
            for step in steps:
                (directory / "trajectory" / step["screenshot"]).write_bytes(bytes.fromhex("89504e470d0a1a0a"))
            _, actions, images, before = judge.evidence(run, "fixture")
            self.assertEqual(actions, ["page -> WAIT -> inspect"])
            self.assertEqual(len(images), 2)
            with Path(images[0]).open("ab") as image:
                image.write(b"changed")
            self.assertNotEqual(before, judge.evidence(run, "fixture")[3])
            result["schema_version"] = "rome-mind2web-tools-v1"
            (directory / "result.json").write_text(json.dumps(result))
            (directory / "commands.json").write_text(json.dumps([{"command": "eval", "args": ["document.title"], "stdout": "Example Domain", "success": True}]))
            _, script_actions, _, script_hash = judge.evidence(run, "fixture")
            self.assertIn("Example Domain", script_actions[0])
            self.assertNotIn("unsupported claim", " ".join(script_actions))
            (directory / "commands.json").write_text(json.dumps([{"command": "eval", "args": ["document.title"], "stdout": "Changed", "success": True}]))
            self.assertNotEqual(script_hash, judge.evidence(run, "fixture")[3])
            Path(images[1]).unlink()
            with self.assertRaises(FileNotFoundError):
                judge.evidence(run, "fixture")


if __name__ == "__main__":
    unittest.main()
