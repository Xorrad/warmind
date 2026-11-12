/**
 * @file The logged-in user, set by main.js before the app loads.
 */

/** @type {{ id: number, username: string, createdAt: string }|null} */
let user = null;

export function setUser(u) {
    user = u;
}

export function currentUser() {
    return user;
}
