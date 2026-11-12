/**
 * @file Login and registration page.
 *
 * Registration needs the server's anti-bot challenge solved: it is fetched
 * and solved in the background as soon as the page opens (about a second),
 * so it is usually ready by the time the form is filled in.
 */

import { getMe, getChallenge, login, register } from './api.js';
import { solveChallenge } from './pow.js';

const params = new URLSearchParams(location.search);
// Only return to a page of this site
const next = (() => {
    const n = params.get('next') ?? '/';
    return n.startsWith('/') && !n.startsWith('//') ? n : '/';
})();

// Already logged in: straight to the game
if (await getMe().catch(() => null)) location.replace(next);

const forms = { login: document.getElementById('login-form'), register: document.getElementById('register-form') };
const tabs = { login: document.getElementById('tab-login'), register: document.getElementById('tab-register') };

function show(name) {
    for (const key of Object.keys(forms)) {
        forms[key].hidden = key !== name;
        tabs[key].setAttribute('aria-selected', String(key === name));
    }
    forms[name].elements.username.focus();
    if (name === 'register') prepareChallenge();
}
tabs.login.addEventListener('click', () => show('login'));
tabs.register.addEventListener('click', () => show('register'));

/* ---------- Anti-bot challenge ---------- */

const verify = forms.register.querySelector('[data-verify]');
/** A bit above the server's minimum challenge age (2 s). */
const MIN_CHALLENGE_AGE_MS = 2300;
let solving = null;

/** Fetch and solve a fresh challenge (once per form submission). */
function prepareChallenge() {
    if (solving) return solving;
    verify.textContent = 'Checking your browser…';
    verify.className = 'auth-verify';
    solving = getChallenge()
        .then(async (challenge) => ({ challenge, nonce: await solveChallenge(challenge), receivedAt: Date.now() }))
        .then((solution) => {
            verify.textContent = '✓ Browser checked';
            verify.className = 'auth-verify done';
            return solution;
        })
        .catch((err) => {
            solving = null;
            verify.textContent = err.message;
            verify.className = 'auth-verify failed';
            throw err;
        });
    return solving;
}

/* ---------- Submissions ---------- */

function setBusy(form, busy, label) {
    const button = form.querySelector('button[type="submit"]');
    button.disabled = busy;
    if (label) button.textContent = label;
}

function fail(form, message, field) {
    form.querySelector('[data-error]').textContent = message;
    if (field) form.elements[field].focus();
}

forms.login.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = forms.login.elements;
    if (!f.username.value.trim() || !f.password.value) return fail(forms.login, 'Enter your username and password.', f.username.value.trim() ? 'password' : 'username');
    fail(forms.login, '');
    setBusy(forms.login, true, 'Logging in…');
    try {
        await login({ username: f.username.value.trim(), password: f.password.value, website: f.website.value });
        location.replace(next);
    } catch (err) {
        fail(forms.login, err.message, 'password');
        f.password.value = '';
        setBusy(forms.login, false, 'Log in');
    }
});

forms.register.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = forms.register.elements;
    const username = f.username.value.trim();
    if (!/^[A-Za-z0-9_-]{3,24}$/.test(username)) return fail(forms.register, 'Usernames are 3 to 24 letters, digits, "_" or "-".', 'username');
    if (f.password.value.length < 8) return fail(forms.register, 'Passwords need at least 8 characters.', 'password');
    if (f.password.value !== f.confirm.value) return fail(forms.register, 'The passwords do not match.', 'confirm');
    fail(forms.register, '');
    setBusy(forms.register, true, 'Creating account…');
    try {
        const { challenge, nonce, receivedAt } = await prepareChallenge();
        // The server refuses challenges answered within 2 s (scripted
        // sign-ups); a fast password manager could beat that: wait a moment
        const wait = MIN_CHALLENGE_AGE_MS - (Date.now() - receivedAt);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        await register({ username, password: f.password.value, challenge, nonce, website: f.website.value });
        location.replace(next);
    } catch (err) {
        // A challenge is single-use: get a new one for the next try
        solving = null;
        prepareChallenge().catch(() => {});
        fail(forms.register, err.message, err.status === 409 ? 'username' : undefined);
        setBusy(forms.register, false, 'Create account');
    }
});

// ?mode=register opens the sign-up form (after everything above is set up)
if (params.get('mode') === 'register') show('register');
else forms.login.elements.username.focus();
