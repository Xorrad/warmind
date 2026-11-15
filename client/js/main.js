/**
 * @file Bootstrap: check the login, then load the app.
 *
 * Not logged in: go to the login page (coming back here afterwards). The
 * app itself (app.js) is only imported once the user is known, because
 * its saved data is kept per user.
 */

import { getMe, getBuild } from './api.js';
import { setUser, setTestSessions } from './user.js';

const [user, build] = await Promise.all([getMe().catch(() => null), getBuild().catch(() => null)]);
if (!user) {
    const back = location.pathname + location.search;
    location.replace(`/login.html?next=${encodeURIComponent(back)}`);
} else {
    setUser(user);
    setTestSessions(build?.testSessions);
    await import('./app.js');
}
