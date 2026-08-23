// SPDX-License-Identifier: GPL-2.0-only

import GLib from 'gi://GLib';

import {AppServerClient} from '../appServerClient.js';

const loop = GLib.MainLoop.new(null, false);
let receivedRateLimits = false;
let receivedUsage = false;
let failed = false;

const timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
    printerr('Timed out waiting for Codex usage data');
    failed = true;
    loop.quit();
    return GLib.SOURCE_REMOVE;
});

const client = new AppServerClient({
    onData: ({rateLimits, usage}) => {
        receivedRateLimits ||= rateLimits !== null;
        receivedUsage ||= usage !== null;
        if (receivedRateLimits && receivedUsage)
            loop.quit();
    },
    onStatus: ({state, message}) => {
        if (state === 'error') {
            printerr(message);
            failed = true;
            loop.quit();
        }
    },
});

client.start();
loop.run();
client.stop();
GLib.source_remove(timeout);

if (failed || !receivedRateLimits || !receivedUsage)
    System.exit(1);

print('Codex app-server smoke test passed');
