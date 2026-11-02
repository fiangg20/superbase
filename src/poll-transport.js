"use strict";

// HTTP long polling, for executors that have no WebSocket. A polling client looks like a WebSocket to the
// rest of the bridge: a PollSession has send(), close(), terminate(), readyState and the "message" and "close"
// events, so the bridge treats both kinds of client the same way.
//
//   POST /poll/hello            body: the hello message     -> { session }   (the welcome arrives with the first poll)
//   GET  /poll/next?session=&wait=<ms>                       -> { messages: [text, ...], closed }
//   POST /poll/send?session=    body: { messages: [text|object, ...] }      -> { ok: true }
//   POST /poll/close?session=                                -> { ok: true }
//
// Messages that go to the executor are the same JSON texts a WebSocket would carry.

const crypto = require("crypto");
const { EventEmitter } = require("events");

const MAX_WAIT_MS = 20000;
const MAX_OUTBOX = 2000;
const MAX_SEND_BATCH = 500;

class PollSession extends EventEmitter {
  constructor(sid, onClosed) {
    super();
    this.sid = sid; // the bridge uses .id for the client id (c1, c2, ...), so the session id has its own name
    this.readyState = 1; // 1 = open, like a WebSocket
    this.outbox = [];
    this.waiter = null;
    this.onClosed = onClosed;
    this.polling = true;
  }

  // Like ws.send: queue a JSON text for the executor.
  send(text) {
    if (this.readyState !== 1) return;
    this.outbox.push(String(text));
    if (this.outbox.length > MAX_OUTBOX) {
      this.close(1011, "The executor did not poll for its messages");
      return;
    }
    this.release();
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.release();
    this.onClosed(this);
    this.emit("close");
  }

  terminate() {
    this.close();
  }

  release() {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(this.drain());
    }
  }

  drain() {
    const messages = this.outbox;
    this.outbox = [];
    return { messages, closed: this.readyState !== 1 };
  }

  // Waits up to waitMs for messages. A newer poll takes over from an older one that is still waiting.
  take(waitMs) {
    if (this.waiter) this.release();
    if (this.outbox.length > 0 || this.readyState !== 1 || waitMs <= 0) return Promise.resolve(this.drain());
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(this.drain());
      }, waitMs);
      this.waiter = { resolve, timer };
    });
  }
}

class PollHub {
  // attach(session) hands a new session to the bridge, like a new WebSocket connection.
  constructor({ attach, maxSessions = 16, now = Date.now }) {
    this.attach = attach;
    this.maxSessions = maxSessions;
    this.now = now;
    this.sessions = new Map();
  }

  get size() {
    return this.sessions.size;
  }

  // Resolves { session } or { error, status }.
  hello(body, token) {
    if (this.sessions.size >= this.maxSessions) return { error: "Too many polling clients", status: 429 };
    const sid = crypto.randomBytes(16).toString("hex");
    const session = new PollSession(sid, (closed) => {
      if (this.sessions.get(closed.sid) === closed) this.sessions.delete(closed.sid);
    });
    session.lastSeen = this.now();
    this.sessions.set(sid, session);
    this.attach(session);
    // The hello travels like a WebSocket message, with the token from the request header.
    session.emit("message", JSON.stringify({ ...body, type: "hello", token }));
    if (!session.authenticated) {
      session.close();
      return { error: "Unauthorized", status: 401 };
    }
    return { session: sid };
  }

  find(id) {
    const session = this.sessions.get(String(id || ""));
    return session && session.readyState === 1 ? session : null;
  }

  async next(id, waitMs) {
    const session = this.find(id);
    if (!session) return null;
    session.lastSeen = this.now();
    const wait = Math.min(MAX_WAIT_MS, Math.max(0, Number(waitMs) || 0));
    const result = await session.take(wait);
    if (session.readyState === 1) session.lastSeen = this.now();
    return result;
  }

  push(id, messages) {
    const session = this.find(id);
    if (!session) return false;
    session.lastSeen = this.now();
    for (const message of messages.slice(0, MAX_SEND_BATCH)) {
      session.emit("message", typeof message === "string" ? message : JSON.stringify(message));
    }
    return true;
  }

  close(id) {
    const session = this.find(id);
    if (!session) return false;
    session.close();
    return true;
  }
}

module.exports = { PollHub, PollSession, MAX_WAIT_MS, MAX_OUTBOX, MAX_SEND_BATCH };
