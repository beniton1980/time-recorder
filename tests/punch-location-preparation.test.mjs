import assert from "node:assert/strict";
import test from "node:test";
import { createPunchLocationReader } from "../lib/punch-location.mjs";
import { measurePunchStage } from "../lib/punch-performance.mjs";

function fixture(state = "granted") {
  let now = 100000;
  const calls = [];
  const reader = createPunchLocationReader({
    now: () => now,
    geolocation: { getCurrentPosition: (success, error, options) => calls.push({ success, error, options }) },
    permissions: { query: async () => ({ state }) },
  });
  return {
    reader, calls,
    advance: (ms) => { now += ms; },
    succeed: (index = 0, { age = 0, accuracy = 10 } = {}) => calls[index].success({
      timestamp: now - age,
      coords: { latitude: 35, longitude: 139, accuracy },
    }),
  };
}

test("already permitted position is prepared once and consumes the fresh sample", async (t) => {
  const f = fixture(); t.after(() => f.reader.clear());
  const preparation = f.reader.prepare(); await Promise.resolve();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].options, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  f.succeed(); await preparation;
  f.advance(1200);
  assert.deepEqual(await f.reader.read(), { latitude: 35, longitude: 139, accuracy: 10 });
  assert.equal(f.calls.length, 1, "the tap must not wait for a second location request");
  const second = f.reader.read(); assert.equal(f.calls.length, 2);
  f.succeed(1); await second;
});

test("a tap during preparation shares the pending request", async (t) => {
  const f = fixture(); t.after(() => f.reader.clear());
  const preparation = f.reader.prepare(); await Promise.resolve();
  const read = f.reader.read(); assert.equal(f.calls.length, 1);
  f.succeed(); await preparation;
  assert.equal((await read).latitude, 35);
});

for (const permission of ["prompt", "denied"]) {
  test(`${permission}: opening the page does not request location`, async (t) => {
    const f = fixture(permission); t.after(() => f.reader.clear());
    await f.reader.prepare(); assert.equal(f.calls.length, 0);
    const read = f.reader.read(); assert.equal(f.calls.length, 1);
    f.calls[0].error({ code: 1 }); assert.equal(await read, null);
  });
}

test("unsupported permission lookup falls back to a normal on-tap request", async (t) => {
  let calls = 0;
  const reader = createPunchLocationReader({
    permissions: { query: async () => { throw new Error("unsupported"); } },
    geolocation: { getCurrentPosition: (_success, error) => { calls++; error({ code: 1 }); } },
  });
  t.after(() => reader.clear());
  await reader.prepare(); assert.equal(calls, 0);
  assert.equal(await reader.read(), null); assert.equal(calls, 1);
});

test("stale samples are reacquired using the original accuracy and timeout", async (t) => {
  const f = fixture(); t.after(() => f.reader.clear());
  const preparation = f.reader.prepare(); await Promise.resolve();
  f.succeed(0, { age: 29000 }); await preparation;
  f.advance(2000);
  const read = f.reader.read(); assert.equal(f.calls.length, 2);
  f.succeed(1); assert.equal((await read).accuracy, 10);
});

test("a failed preparation is retried on tap, low accuracy is passed to server judgment", async (t) => {
  const f = fixture(); t.after(() => f.reader.clear());
  const preparation = f.reader.prepare(); await Promise.resolve();
  f.calls[0].error({ code: 3 }); await preparation;
  const read = f.reader.read(); assert.equal(f.calls.length, 2);
  f.succeed(1, { accuracy: 500 }); assert.equal((await read).accuracy, 500);
});

test("clearing the screen prevents late preparation from repopulating memory", async (t) => {
  const f = fixture(); t.after(() => f.reader.clear());
  const preparation = f.reader.prepare(); await Promise.resolve();
  f.reader.clear(); f.succeed(); await preparation;
  const read = f.reader.read(); assert.equal(f.calls.length, 2);
  f.succeed(1); await read;
});

test("clearing while permission lookup is pending prevents a background request", async () => {
  let resolve; let calls = 0;
  const reader = createPunchLocationReader({
    permissions: { query: () => new Promise((r) => { resolve = r; }) },
    geolocation: { getCurrentPosition: () => { calls++; } },
  });
  const preparation = reader.prepare(); reader.clear();
  resolve({ state: "granted" }); await preparation;
  assert.equal(calls, 0);
});

test("missing geolocation keeps Soft GPS's unavailable result", async () => {
  const reader = createPunchLocationReader({});
  await reader.prepare(); assert.equal(await reader.read(), null); reader.clear();
});

test("performance entries are bounded and preserve success or failure", async () => {
  const name = "onogami:punch:send";
  for (let i = 0; i < 4; i++) assert.equal(await measurePunchStage("send", async () => 7), 7);
  await assert.rejects(measurePunchStage("send", async () => { throw new Error("fixture"); }), /fixture/);
  const entries = performance.getEntriesByName(name);
  assert.equal(entries.length, 1); assert.equal(entries[0].detail, null);
  performance.clearMeasures(name);
});
