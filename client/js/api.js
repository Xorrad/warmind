/**
 * @file Fetch wrappers for auth, campaign and tasks endpoints.
 *
 * Every call sends JSON and returns the parsed body; failures throw an
 * Error carrying the server's message and the HTTP status.
 */

async function call(method, path, body) {
    const res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
        const err = new Error(data?.error ?? `${method} ${path} failed (${res.status})`);
        err.status = res.status;
        throw err;
    }
    return data;
}

/**
 * @returns {Promise<{version: string, commit: string|null, env: string, builtAt: string}>}
 */
export function getBuild() {
    return call('GET', '/api/build');
}

/** The logged-in user, or null. */
export async function getMe() {
    try {
        return (await call('GET', '/api/auth/me')).user;
    } catch (err) {
        if (err.status === 401) return null;
        throw err;
    }
}

export const getChallenge = () => call('GET', '/api/auth/challenge');
export const login = (fields) => call('POST', '/api/auth/login', fields).then((d) => d.user);
export const register = (fields) => call('POST', '/api/auth/register', fields).then((d) => d.user);
export const logout = () => call('POST', '/api/auth/logout', {});
