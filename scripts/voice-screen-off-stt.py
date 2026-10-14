"""Offline recognizer for the isolated Android proof; no provider keys or billing."""
import json
import sys
from pocketsphinx import Decoder, Endpointer

recognizer = Decoder(samprate=16000, logfn='/dev/null')
recognizer.add_jsgf_string('proof', '#JSGF V1.0; grammar proof; public <command> = hello ruby | ruby work | stop conversation;')
recognizer.activate_search('proof')
endpoint = Endpointer(sample_rate=16000)
turn = 0
while True:
    frame = sys.stdin.buffer.read(endpoint.frame_bytes)
    if len(frame) != endpoint.frame_bytes:
        break
    was_speech = endpoint.in_speech
    speech = endpoint.process(frame)
    if speech is None:
        continue
    if not was_speech:
        recognizer.start_utt()
    recognizer.process_raw(speech, False, False)
    if not endpoint.in_speech:
        recognizer.end_utt()
        hyp = recognizer.hyp()
        if hyp is not None and hyp.hypstr:
            print(json.dumps({'event': 'EndOfTurn', 'transcript': hyp.hypstr, 'turn_index': turn}), flush=True)
            turn += 1
