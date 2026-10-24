/** Android playback observer for the existing disposable SSE/PCM proof.
 * Run with a dedicated PulseAudio monitor and VOICE_PROOF_EVENTS destination.
 * Times PCM publication and monitor onset in the same monotonic clock.
 * This measures the controlled Android path, never live end-to-end latency.
 */
import { AudioSource } from '@livekit/rtc-node';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const destination = process.env.VOICE_PROOF_EVENTS ?? '/tmp/beeline-voice-speed.jsonl';
const monitor = process.env.VOICE_PROOF_MONITOR ?? 'emberus_voice_proof.monitor';
const record = (row: unknown) => appendFileSync(destination, JSON.stringify(row)+'\n');
const original = AudioSource.prototype.captureFrame;
let previousFrame = -Infinity;
AudioSource.prototype.captureFrame = function(frame) {
  const now=Number(process.hrtime.bigint()) / 1e6;
  if(now-previousFrame>500 && frame.data.some(value=>Math.abs(value)>150)) record({event:'published',at:now,wall:Date.now()});
  previousFrame=now;
  return original.call(this,frame);
};
// Observe in a separate process: fixture database work must not delay the
// timestamp of monitor samples waiting in Node's event loop. Both clocks use
// CLOCK_MONOTONIC on Linux. This is emulator output, not a physical microphone.
const capture=spawn('python3',['-u','-c',`
import json, os, struct, subprocess, sys, time
capture = subprocess.Popen(['parec', '--device='+sys.argv[1], '--raw',
  '--format=s16le', '--rate=24000', '--channels=1',
  '--latency-msec=5', '--process-time-msec=5'], stdout=subprocess.PIPE)
quiet = 24000
pending = b''
try:
  while True:
    chunk = os.read(capture.stdout.fileno(), 480)
    now = time.monotonic_ns() / 1e6
    if not chunk: break
    pending += chunk
    size = len(pending) // 2 * 2
    for i, (sample,) in enumerate(struct.iter_unpack('<h', pending[:size])):
      if abs(sample) > 150:
        if quiet > 12000:
          with open(sys.argv[2], 'a') as output:
            output.write(json.dumps({'event':'sound', 'at':now-(size-i*2)/48,
              'wall':time.time_ns()/1e6, 'batchMs':size/48})+'\\n')
        quiet = 0
      else: quiet += 1
    pending = pending[size:]
finally:
  capture.terminate()
`,monitor,destination]);
capture.stderr.on('data',chunk=>console.error(String(chunk)));
process.on('exit',()=>capture.kill());
void import('./prove-voice-delivery.js');
