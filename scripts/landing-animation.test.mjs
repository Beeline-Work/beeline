import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'relay-stack', 'web', 'index.html'), 'utf8');

class FakeClassList {
  #classes = new Set();

  add(...names) {
    names.forEach((name) => this.#classes.add(name));
  }

  remove(...names) {
    names.forEach((name) => this.#classes.delete(name));
  }

  toggle(name, force) {
    const enabled = force ?? !this.#classes.has(name);
    if (enabled) this.#classes.add(name);
    else this.#classes.delete(name);
    return enabled;
  }

  contains(name) {
    return this.#classes.has(name);
  }
}

function element(dataset = {}) {
  return {
    dataset,
    classList: new FakeClassList(),
    style: { setProperty() {} },
    setAttribute() {},
    appendChild() {},
    remove() {},
    parentElement: null,
    clientWidth: 0,
    innerHTML: '',
  };
}

function runLandingAnimation({ reducedMotion }) {
  const stage = element();
  const wrap = element();
  wrap.clientWidth = 880;
  stage.parentElement = wrap;
  const wires = element();
  const screen = element();
  const track = element();
  const approve = element();
  const nodes = [
    ['claude code', 86, 92, 58, 48],
    ['codex', 66, 232, 150, 48],
    ['pi', 74, 372, 240, 48],
    ['goose', 104, 508, 328, 48],
    ['@tomcain', 792, 150, 98, 792],
    ['@bananaman', 800, 372, 284, 792],
  ].map(([id, x, y, mx, my]) => element({ id, x, y, mx, my }));
  const roomTurns = Array.from({ length: 5 }, () => element());
  const cornerTurns = Array.from({ length: 3 }, () => element());
  const allTurns = [...roomTurns, ...cornerTurns];
  const byId = { stage, wires, screen, track, approve };
  const document = {
    getElementById: (id) => byId[id],
    querySelectorAll: (selector) => {
      if (selector === '.node') return nodes;
      if (selector === '#room-ledger .turn') return roomTurns;
      if (selector === '#corner-ledger .turn') return cornerTurns;
      return [];
    },
    createElementNS: () => element(),
  };

  let now = 0;
  let nextTimerId = 1;
  const timers = [];
  const setTimeout = (callback, delay) => {
    const timer = { id: nextTimerId++, at: now + delay, callback, cancelled: false };
    timers.push(timer);
    return timer.id;
  };
  const clearTimeout = (id) => {
    const timer = timers.find((candidate) => candidate.id === id);
    if (timer) timer.cancelled = true;
  };
  const advanceTo = (target) => {
    while (true) {
      const timer = timers
        .filter((candidate) => !candidate.cancelled && candidate.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!timer) break;
      timer.cancelled = true;
      now = timer.at;
      timer.callback();
    }
    now = target;
  };

  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, 'expected one landing-page script');
  vm.runInNewContext(scripts[0][1], {
    document,
    matchMedia: () => ({ matches: reducedMotion }),
    addEventListener() {},
    requestAnimationFrame: (callback) => callback(),
    setTimeout,
    clearTimeout,
  });

  return {
    advanceTo,
    visibleTurns: () => allTurns.filter((turn) => turn.classList.contains('in')).length,
    pendingTimers: () => timers.filter((timer) => !timer.cancelled).length,
  };
}

test('landing transcript starts empty on every animated cycle and rests complete for reduced motion', () => {
  const animated = runLandingAnimation({ reducedMotion: false });
  assert.equal(animated.visibleTurns(), 0, 'fresh load must render the intended empty first frame');

  animated.advanceTo(4_500);
  assert.equal(animated.visibleTurns(), 0, 'starting a cycle must preserve the empty first frame');
  animated.advanceTo(5_400);
  assert.equal(animated.visibleTurns(), 1, 'the first scripted turn should begin the transcript');

  animated.advanceTo(32_400);
  assert.equal(animated.visibleTurns(), 0, 'replay must reset to the same empty first frame');
  animated.advanceTo(33_300);
  assert.equal(animated.visibleTurns(), 1, 'replay should progress from its first scripted turn');

  const reduced = runLandingAnimation({ reducedMotion: true });
  assert.equal(
    reduced.visibleTurns(),
    8,
    'reduced motion should keep the completed static transcript',
  );
  assert.equal(reduced.pendingTimers(), 0, 'reduced motion should not schedule animation work');
});
