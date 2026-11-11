import importlib.machinery
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load(name, filename):
    loader = importlib.machinery.SourceFileLoader(name, str(ROOT / filename))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


vc = load("vc_launcher", "scripts/vc")
stats = load("vc_stats", "scripts/stats.py")


def device(name, serial="abc"):
    return {"name": name, "description": "Test USB device", "properties": {"device.serial": serial}}


def test_pair_requires_explicit_binding_and_matching_devices():
    binding = {
        "source": {"name": "mic", "properties": {}},
        "sink": {"name": "speaker", "properties": {}},
    }
    assert vc.select_pair([device("mic")], [device("speaker")], None) is None
    assert vc.select_pair([], [], binding) is None
    assert vc.select_pair([device("mic")], [device("speaker")], binding) == ("mic", "speaker")
    monitor_binding = {**binding, "source": {"name": "speaker.monitor", "properties": {}}}
    assert vc.select_pair([device("speaker.monitor")], [device("speaker")], monitor_binding) is None
    assert vc.select_pair([device("mic")], [device("speaker", "different")], binding) == ("mic", "speaker")
    assert vc.select_pair([device("mic2")], [device("speaker")], binding) is None


def test_binding_checks_hardware_properties():
    binding = {
        "source": {"name": "mic", "properties": {"device.serial": "abc"}},
        "sink": {"name": "speaker", "properties": {"device.serial": "abc"}},
    }
    assert vc.select_pair([device("mic")], [device("speaker")], binding)
    assert vc.select_pair([device("mic", "changed")], [device("speaker")], binding) is None


def test_percentiles_and_late_cancelled_usage(tmp_path):
    import json

    rows = [
        {"event": "turn_summary", "data": {"status": "completed", "metrics": {"eos_to_audio_ms": n}}}
        for n in range(1, 101)
    ]
    rows += [
        {"event": "turn_summary", "data": {"status": "interrupted", "metrics": {"eos_to_audio_ms": 9999}}},
        {"event": "usage", "session_id": "s", "turn_id": 1, "data": {"usd": 0.01, "input": 5}},
        {"event": "usage", "session_id": "s", "turn_id": 1, "data": {"usd": 0.02, "input": 10}},
    ]
    path = tmp_path / "session.jsonl"
    path.write_text("\n".join(map(json.dumps, rows)) + '\n{"partial":')
    report = stats.report([path])
    assert report["latency_ms"]["eos_to_audio_ms"] == {"n": 100, "p50": 50, "p95": 95}
    assert report["usage"]["usd"] == 0.02
    assert report["usage"]["input_tokens"] == 10


def test_stats_before_first_conversation(tmp_path):
    report = stats.report([tmp_path / "logs"])
    assert report["statuses"] == {}
    assert report["latency_ms"] == {}
    assert report["usage"]["reported_turns"] == 0


def test_shared_agent_settings_replace_legacy_environment_limits():
    env = vc.agent_environment(
        {"VC_HISTORY_TURNS": "8", "VC_MAX_TOKENS": "384", "OTHER": "preserved"},
        {"agent": {"history_turns": 96, "max_response_tokens": 2048}},
    )
    assert env == {"VC_HISTORY_TURNS": "96", "VC_MAX_TOKENS": "2048", "OTHER": "preserved"}
    assert vc.agent_environment({}, {}) == {"VC_HISTORY_TURNS": "64", "VC_MAX_TOKENS": "1024"}
