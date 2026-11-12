/**
 * @file Bootstrap: check the login, then load the app.
 *
 * Not logged in: go to the login page (coming back here afterwards). The
 * app itself (app.js) is only imported once the user is known, because
 * its saved data is kept per user.
 */

import { getMe } from './api.js';
import { setUser } from './user.js';

const user = await getMe().catch(() => null);
if (!user) {
    const back = location.pathname + location.search;
    location.replace(`/login.html?next=${encodeURIComponent(back)}`);
} else {
    setUser(user);
    await import('./app.js');
}
