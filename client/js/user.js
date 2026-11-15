/**
 * @file Context known before the app loads (set by main.js): the logged-in
 * user and what the server allows.
 */

/** @type {{ id: number, username: string, createdAt: string }|null} */
let user = null;
let testSessions = false;

export function setUser(u) {
    user = u;
}

export function currentUser() {
    return user;
}

/** Whether test sessions (?session=..., Skip day) are enabled on this server. */
export function setTestSessions(allowed) {
    testSessions = Boolean(allowed);
}

export function testSessionsAllowed() {
    return testSessions;
}
