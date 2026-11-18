import { describe, expect, test } from "bun:test";
import { createCoalescedSeeker, type SeekableMedia } from "../coalescedSeek";

/** A fake <video>: assigning currentTime starts a seek that lands when `land()` is called. */
class FakeMedia implements SeekableMedia {
  private time = 0;
  seeking = false;
  writes: number[] = [];
  private listeners = new Set<() => void>();

  get currentTime() {
    return this.time;
  }
  set currentTime(t: number) {
    this.time = t;
    this.seeking = true;
    this.writes.push(t);
  }
  addEventListener(_type: "seeked", fn: () => void) {
    this.listeners.add(fn);
  }
  removeEventListener(_type: "seeked", fn: () => void) {
    this.listeners.delete(fn);
  }
  land() {
    this.seeking = false;
    this.listeners.forEach((fn) => fn());
  }
}

describe("createCoalescedSeeker", () => {
  test("a slider drag issues one seek at a time and always lands on the last position", () => {
    const media = new FakeMedia();
    const seeker = createCoalescedSeeker(media, 0.2);
    for (let t = 1; t <= 20; t++) seeker.request(t); // 20 input events while the first seek decodes
    expect(media.writes).toEqual([1]);
    media.land();
    expect(media.writes).toEqual([1, 20]); // intermediate positions dropped
    media.land();
    expect(media.writes).toEqual([1, 20]); // nothing left to do
  });

  test("requests within tolerance of the current or in-flight target are ignored", () => {
    const media = new FakeMedia();
    const seeker = createCoalescedSeeker(media, 0.2);
    seeker.request(0.1);
    expect(media.writes).toEqual([]);
    seeker.request(5);
    seeker.request(5.1); // same place as in flight
    media.land();
    expect(media.writes).toEqual([5]);
  });

  test("a seek already running in the element (e.g. from playback code) is not interrupted", () => {
    const media = new FakeMedia();
    media.seeking = true;
    const seeker = createCoalescedSeeker(media, 0.2);
    seeker.request(8);
    expect(media.writes).toEqual([]);
    media.land();
    expect(media.writes).toEqual([8]);
  });

  test("dispose drops the pending target and stops listening", () => {
    const media = new FakeMedia();
    const seeker = createCoalescedSeeker(media, 0.2);
    seeker.request(3);
    seeker.request(9);
    seeker.dispose();
    media.land();
    expect(media.writes).toEqual([3]);
  });
});
