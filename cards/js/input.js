// Pointer, wheel and keys -> step-stamped commands for the World. Real events become commands for the
// next step; while a drag is held the pointer x is sampled every step. Everything lands in the input log.

import { CONFIG } from './config.js';
import { ndcToPlane, slotAtScreenX, slotPose } from './fan.js';

const SP = CONFIG.spin;

// ---------------------------------------------------------------- pure command builders

// What a drag needs to keep card c under the pointer: its slot at pointer-down and the pointer's
// offset from the card's slot pose on screen.
export function dragGrab(proj, c, xPx) {
  const pose = slotPose(c.k.s, c.imp);
  return { index: c.index, imp: c.imp, s0: c.k.s, offsetPx: xPx - proj.project(pose.x, pose.y, pose.z, [0, 0, 0])[0] };
}

// The drag offset (slots) that puts the grabbed card under a pointer at screen x.
export const dragSlots = (proj, grab, xPx) => grab.s0 - slotAtScreenX(proj, grab.imp, grab.s0, xPx - grab.offsetPx);

// A scripted drag of dxPx screen pixels over `steps` steps (eased like a hand: it accelerates and is
// still moving at release), starting at pointer x0Px on card `grab`.
export function dragScript(proj, startStep, x0Px, dxPx, steps, grab, xOrigin) {
  const out = [{ type: 'down', step: startStep, xOrigin, grab: grab.index }];
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    const x = x0Px + dxPx * u * u * (2 - u);
    out.push({ type: 'move', step: startStep + i, d: dragSlots(proj, grab, x), x });
  }
  out.push({ type: 'up', step: startStep + steps + 1 });
  return out;
}

export const keyDir = (code) => (code === 'ArrowRight' ? 1 : code === 'ArrowLeft' ? -1 : 0);

// Classifies wheel events as discrete notches or a trackpad stream (wall-clock gaps matter here).
export class WheelClassifier {
  constructor() { this.lastT = -Infinity; }
  // Returns {type: 'notch', dir} or {type: 'pad', delta} in slot-pixels, or null.
  classify(deltaX, deltaY, deltaMode, nowSec) {
    const W = SP.wheel;
    const scale = deltaMode === 1 ? W.lineScale : deltaMode === 2 ? W.pageScale : 1;
    const dx = deltaX * scale, dy = deltaY * scale;
    const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
    const gap = nowSec - this.lastT;
    this.lastT = nowSec;
    if (!delta) return null;
    const notch = deltaMode !== 0 || (Math.abs(delta) >= W.notchMin && Number.isInteger(delta) && !deltaX && gap > W.notchGap);
    return notch ? { type: 'notch', dir: Math.sign(delta) } : { type: 'pad', delta };
  }
}

// ---------------------------------------------------------------- DOM controller

// view provides: rect (cached CSS rect of the canvas), proj and cam (the camera as drawn), pick(world, x, y).
export class InputController {
  constructor(el, world, view, hooks) {
    this.el = el; this.world = world; this.view = view; this.hooks = hooks;
    this.wheel = new WheelClassifier();
    this.drag = null;
    this.lastKeyT = -Infinity;
    this.over = false;
    this.listen();
  }

  // Before interactiveAt, input is logged but only hurries the deal along (the World ignores it).
  early() {
    if (this.world.t < this.world.interactiveAt) this.hooks.hurry();
  }

  send(cmd) {
    const c = this.world.input(cmd, { live: true });
    this.hooks.onInput?.(c);
    return c;
  }

  feltX(clientX, clientY) {
    const r = this.view.rect;
    const nx = ((clientX - r.left) / r.width) * 2 - 1, ny = 1 - ((clientY - r.top) / r.height) * 2;
    return ndcToPlane(this.view.cam, nx, ny, 0, [0, 0])[0];
  }

  listen() {
    const el = this.el;
    el.addEventListener('pointerenter', () => { this.over = true; });
    el.addEventListener('pointerleave', () => { this.over = false; });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.hooks.onPointer?.(e);
      this.early();
      el.setPointerCapture(e.pointerId);
      const r = this.view.rect, x = e.clientX - r.left;
      const index = this.view.pick(this.world, x, e.clientY - r.top);
      const grab = index >= 0 ? dragGrab(this.view.proj, this.world.cards[index], x) : null;
      this.drag = { id: e.pointerId, x0: e.clientX, x: e.clientX, lastD: 0, grab };
      this.send({ type: 'down', xOrigin: this.feltX(e.clientX, e.clientY), grab: index });
    });
    el.addEventListener('pointermove', (e) => {
      this.hooks.onPointer?.(e);
      if (this.drag && e.pointerId === this.drag.id) this.drag.x = e.clientX;
    });
    const end = (e) => {
      if (!this.drag || e.pointerId !== this.drag.id) return;
      this.sample();
      this.drag = null;
      this.send({ type: 'up' });
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      if (!this.over) return;
      e.preventDefault();
      this.early();
      const c = this.wheel.classify(e.deltaX, e.deltaY, e.deltaMode, e.timeStamp / 1000);
      if (c) this.send(c);
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      const dir = keyDir(e.code);
      if (!dir) return;
      e.preventDefault();
      this.early();
      const t = this.world.t;
      if (e.repeat && t - this.lastKeyT < SP.keys.repeat) return;
      this.lastKeyT = t;
      this.send({ type: 'key', dir });
    });
  }

  // Called once per sim step by the loop: the held pointer becomes a move command when it changed.
  // A grabbed card is solved to sit exactly under the finger; otherwise the fan moves a slot per slotPx.
  sample() {
    const d = this.drag;
    if (!d) return;
    const slots = d.grab ? dragSlots(this.view.proj, d.grab, d.x - this.view.rect.left) : -(d.x - d.x0) / this.view.slotPx;
    if (slots !== d.lastD) {
      d.lastD = slots;
      this.send({ type: 'move', d: slots });
    }
  }
}
