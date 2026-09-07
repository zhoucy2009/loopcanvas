"""Offline waveform diarization. No network access or identity inference."""
import json
import pathlib
import sys
import wave
import numpy as np
import sherpa_onnx

request = json.loads(pathlib.Path(sys.argv[1]).read_text())
root = pathlib.Path(request["models"])
with wave.open(request["audioPath"], "rb") as source:
    if source.getnchannels() != 1 or source.getframerate() != 16000 or source.getsampwidth() != 2:
        raise ValueError("Expected mono 16 kHz signed 16-bit PCM WAV")
    audio = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
    segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
        pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(root / "segmentation.onnx")), num_threads=2),
    embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(root / "embedding.onnx"), num_threads=2),
    clustering=sherpa_onnx.FastClusteringConfig(num_clusters=request.get("numSpeakers", -1), threshold=request.get("threshold", 0.9)),
    min_duration_on=0.3, min_duration_off=0.5)
if not config.validate():
    raise ValueError("Invalid diarization model configuration")
di = sherpa_onnx.OfflineSpeakerDiarization(config)
result = di.process(audio).sort_by_start_time()
ids = {}
turns = []
for item in result:
    identity = ids.setdefault(item.speaker, "speaker_" + str(len(ids) + 1))
    turns.append({"speakerId": identity, "startSeconds": round(float(item.start), 3), "endSeconds": round(float(item.end), 3)})
if not turns:
    raise ValueError("No speech detected")
# Overlapping voices remain unresolved, rather than assigning two people to one voice.
for i, turn in enumerate(turns):
    turn["overlap"] = any(other["speakerId"] != turn["speakerId"] and min(other["endSeconds"], turn["endSeconds"]) - max(other["startSeconds"], turn["startSeconds"]) > 0.1 for other in turns if other is not turn)
speakers = []
for identity in ids.values():
    own = [turn for turn in turns if turn["speakerId"] == identity]
    examples = sorted([turn for turn in own if not turn["overlap"] and turn["endSeconds"] - turn["startSeconds"] >= 1], key=lambda t: t["endSeconds"] - t["startSeconds"], reverse=True)[:3]
    samples = []
    for index, turn in enumerate(examples):
        start = turn["startSeconds"]
        end = min(turn["endSeconds"], start + 8)
        file = pathlib.Path(request["outputDirectory"]) / (identity + "-" + str(index + 1) + ".wav")
        pcm = np.clip(audio[int(start * 16000):int(end * 16000)] * 32768, -32768, 32767).astype("<i2")
        with wave.open(str(file), "wb") as target:
            target.setnchannels(1); target.setsampwidth(2); target.setframerate(16000); target.writeframes(pcm.tobytes())
        samples.append({"path": str(file), "startSeconds": start, "endSeconds": end})
    speakers.append({"id": identity, "label": "说话人 " + str(len(speakers) + 1), "turnCount": len(own), "durationSeconds": round(sum(t["endSeconds"] - t["startSeconds"] for t in own), 2), "samples": samples})
print(json.dumps({"engine": "sherpa-onnx", "engineVersion": "1.13.7", "durationSeconds": len(audio) / 16000, "speakers": speakers, "turns": turns, "overlapCount": sum(t["overlap"] for t in turns)}, ensure_ascii=False))
