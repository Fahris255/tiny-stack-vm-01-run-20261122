// Tiny stack VM, make.fun tiny-stack-vm-01 (program/v1, Node 22): run
// program.bin on input.bin per instance, write stdout.bin + exit.txt.
// Wrapping i32, stack 256, calls 64, memory 256, steps 1e6, output 65536,
// traps 2..11 in ISA order (steps, pc, opcode, imm, under/overflow, own).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Opcode metadata by byte: [imm bytes, pops, pushes]. No entry = trap 5;
// 0x1f is deliberately absent (not an opcode).
const META: (readonly [number, number, number] | undefined)[] = [];
function def(byte: number, imm: number, pops: number, pushes: number): void {
  META[byte] = [imm, pops, pushes];
}
def(0x00, 0, 0, 0); def(0x01, 1, 0, 1); def(0x02, 4, 0, 1);
def(0x03, 0, 1, 0); def(0x04, 0, 1, 2); def(0x05, 0, 2, 2);
def(0x06, 0, 2, 3); def(0x07, 0, 3, 3);
def(0x10, 0, 2, 1); def(0x11, 0, 2, 1); def(0x12, 0, 2, 1);
def(0x13, 0, 2, 1); def(0x14, 0, 2, 1); def(0x15, 0, 2, 1);
def(0x16, 0, 2, 1); def(0x17, 0, 1, 1); def(0x18, 0, 2, 1);
def(0x19, 0, 2, 1); def(0x1a, 0, 2, 1); def(0x1b, 0, 1, 1);
def(0x1c, 0, 2, 1); def(0x1d, 0, 2, 1); def(0x1e, 0, 2, 1);
def(0x20, 0, 2, 1); def(0x21, 0, 2, 1); def(0x22, 0, 2, 1);
def(0x30, 2, 0, 0); def(0x31, 2, 1, 0); def(0x32, 2, 1, 0);
def(0x33, 2, 0, 0); def(0x34, 0, 0, 0);
def(0x40, 0, 1, 1); def(0x41, 0, 2, 0);
def(0x50, 0, 1, 0); def(0x51, 0, 1, 0); def(0x52, 0, 0, 1); def(0x53, 0, 1, 0);

// Run one program to halt/exit/trap; output before a trap is kept.
function run(prog: Uint8Array, input: Uint8Array): { bytes: Uint8Array; code: number } {
  const stack = new Int32Array(256);
  const calls = new Int32Array(64);
  const mem = new Int32Array(256);
  const out = new Uint8Array(65_536);
  let sp = 0, csp = 0, olen = 0, inPos = 0, pc = 0, steps = 0;
  const finish = (code: number): { bytes: Uint8Array; code: number } => ({
    bytes: out.slice(0, olen), code,
  });
  for (;;) {
    if (steps === 1_000_000) return finish(10);
    if (pc < 0 || pc >= prog.length) return finish(9);
    const byte = prog[pc];
    const meta = META[byte];
    if (meta === undefined) return finish(5);
    const [imm, pops, pushes] = meta;
    if (pc + imm >= prog.length) return finish(9);
    steps++;
    const next = pc + 1 + imm;
    if (sp < pops) return finish(2);
    if (sp - pops + pushes > 256) return finish(3);
    pc = next;
    // Binary ops share one shape: b is the top of stack, a sits below it.
    if (byte >= 0x10 && byte <= 0x22 && byte !== 0x17 && byte !== 0x1b) {
      const b = stack[sp - 1];
      const a = stack[sp - 2];
      let r = 0;
      if (byte === 0x10) r = (a + b) | 0;
      else if (byte === 0x11) r = (a - b) | 0;
      else if (byte === 0x12) r = Math.imul(a, b);
      else if (byte === 0x13) {
        if (b === 0) return finish(4);
        r = ((a - (a % b)) / b) | 0; // exact; INT_MIN / -1 wraps via |0
      } else if (byte === 0x14) {
        if (b === 0) return finish(4);
        r = (a % b) | 0; // JS % keeps dividend's sign; x % -1 is 0
      } else if (byte === 0x15) {
        if (b === 0) return finish(4);
        const au = a >>> 0, bu = b >>> 0;
        r = ((au - (au % bu)) / bu) | 0;
      } else if (byte === 0x16) {
        if (b === 0) return finish(4);
        r = ((a >>> 0) % (b >>> 0)) | 0;
      } else if (byte === 0x18) r = a & b;
      else if (byte === 0x19) r = a | b;
      else if (byte === 0x1a) r = a ^ b;
      else if (byte === 0x1c) r = a << (b & 31);
      else if (byte === 0x1d) r = a >> (b & 31);
      else if (byte === 0x1e) r = (a >>> (b & 31)) | 0;
      else if (byte === 0x20) r = a === b ? 1 : 0;
      else if (byte === 0x21) r = a < b ? 1 : 0;
      else r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU
      sp--;
      stack[sp - 1] = r;
      continue;
    }
    switch (byte) {
      case 0x00: return finish(0); // HALT
      case 0x01: stack[sp++] = (prog[next - 1] << 24) >> 24; break; // PUSH8
      case 0x02: // PUSH32 little-endian
        stack[sp++] = prog[next - 4] | (prog[next - 3] << 8) |
          (prog[next - 2] << 16) | (prog[next - 1] << 24);
        break;
      case 0x03: sp--; break; // POP
      case 0x04: stack[sp] = stack[sp - 1]; sp++; break; // DUP
      case 0x05: { // SWAP
        const t = stack[sp - 1];
        stack[sp - 1] = stack[sp - 2]; stack[sp - 2] = t;
        break;
      }
      case 0x06: stack[sp] = stack[sp - 2]; sp++; break; // OVER
      case 0x07: { // ROT (a b c -- b c a)
        const a = stack[sp - 3];
        stack[sp - 3] = stack[sp - 2]; stack[sp - 2] = stack[sp - 1];
        stack[sp - 1] = a;
        break;
      }
      case 0x17: stack[sp - 1] = (-stack[sp - 1]) | 0; break; // NEG
      case 0x1b: stack[sp - 1] = ~stack[sp - 1]; break; // NOT
      case 0x30: case 0x31: case 0x32: { // JMP / JZ / JNZ, offset from next
        const rel = ((prog[next - 2] | (prog[next - 1] << 8)) << 16) >> 16;
        let jump = byte === 0x30;
        if (byte !== 0x30) {
          const v = stack[--sp];
          jump = byte === 0x31 ? v === 0 : v !== 0;
        }
        if (jump) pc = next + rel;
        break;
      }
      case 0x33: // CALL, absolute unsigned target
        if (csp === 64) return finish(7);
        calls[csp++] = next;
        pc = prog[next - 2] | (prog[next - 1] << 8);
        break;
      case 0x34: // RET
        if (csp === 0) return finish(8);
        pc = calls[--csp];
        break;
      case 0x40: { // LOAD
        const addr = stack[sp - 1];
        if (addr < 0 || addr >= 256) return finish(6);
        stack[sp - 1] = mem[addr];
        break;
      }
      case 0x41: { // STORE (v addr --)
        const addr = stack[sp - 1];
        if (addr < 0 || addr >= 256) return finish(6);
        mem[addr] = stack[sp - 2];
        sp -= 2;
        break;
      }
      case 0x50: { // PRINT decimal ASCII
        const text = String(stack[sp - 1]);
        if (olen + text.length > 65_536) return finish(11);
        sp--;
        for (let i = 0; i < text.length; i++) out[olen++] = text.charCodeAt(i);
        break;
      }
      case 0x51: // PUTC
        if (olen + 1 > 65_536) return finish(11);
        out[olen++] = stack[--sp] & 255;
        break;
      case 0x52: // IN, -1 once input is used up
        stack[sp++] = inPos < input.length ? input[inPos++] : -1;
        break;
      case 0x53: return finish(stack[--sp] & 255); // EXIT
      default: return finish(5);
    }
  }
}

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(IN_DIR).sort()) {
  const prog = readFileSync(join(IN_DIR, id, 'program.bin'));
  let input: Uint8Array;
  try {
    input = readFileSync(join(IN_DIR, id, 'input.bin'));
  } catch {
    input = new Uint8Array(0);
  }
  const { bytes, code } = run(prog, input);
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'stdout.bin'), bytes);
  writeFileSync(join(OUT_DIR, id, 'exit.txt'), `${code}\n`);
}
