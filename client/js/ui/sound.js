/**
 * @file Pen sounds, synthesised with the Web Audio API (no sound files).
 *
 * A pen on paper is a band of noise (the nib scratching the fibres) whose
 * loudness wobbles with the hand. The context is created on the first
 * click (browsers only allow sound after a user gesture). They are kept
 * quiet: a cue, not a sound effect.
 */

let ctx = null;
let noise = null;

function audio() {
    if (ctx) return ctx;
    const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Context) return null;
    ctx = new Context();
    // Two seconds of white noise, reused by every stroke
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return ctx;
}

/**
 * One smooth pen stroke: the nib's scratch is a narrow band of noise (a
 * wide band sounds like sand), gliding up as the pen speeds across, with
 * the hiss above it cut. One swell of pressure, no wobble: one movement.
 * @param {number} duration Seconds.
 * @param {number} pitch Centre of the scratch, in Hz.
 * @param {number} volume 0 to 1.
 */
function stroke(duration, pitch, volume) {
    const ac = audio();
    if (!ac) return;
    if (ac.state === 'suspended') ac.resume();
    const t = ac.currentTime + 0.01;
    const end = t + duration;

    const source = ac.createBufferSource();
    source.buffer = noise;

    const band = ac.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 7;
    band.frequency.setValueAtTime(pitch * 0.75, t);
    band.frequency.exponentialRampToValueAtTime(pitch * 1.2, t + duration * 0.6);
    band.frequency.exponentialRampToValueAtTime(pitch, end);
    // Cut the fine hiss that makes it sound sandy
    const smooth = ac.createBiquadFilter();
    smooth.type = 'lowpass';
    smooth.frequency.value = pitch * 2;
    smooth.Q.value = 0.5;

    // The hand: the nib lands, the line is drawn, the pen lifts
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.04);
    gain.gain.setValueAtTime(volume, t + duration * 0.55);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    source.connect(band).connect(smooth).connect(gain).connect(ac.destination);
    source.start(t, Math.random(), duration + 0.05);
}

/** Crossing a task out: one stroke across the title. */
export function playCrossOut() {
    stroke(0.55, 1900, 0.5);
}

/** Unchecking: a short, lighter stroke. */
export function playUncross() {
    stroke(0.2, 1600, 0.3);
}
