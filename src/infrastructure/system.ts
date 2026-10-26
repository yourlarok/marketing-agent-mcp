import { randomUUID } from "node:crypto";
import type { Clock, Id, IdGenerator, Instant } from "../application/ports.js";

export class SystemClock implements Clock {
  now(): Instant {
    return new Date().toISOString();
  }
}

export class SystemIdGenerator implements IdGenerator {
  next(): Id {
    return randomUUID();
  }
}
