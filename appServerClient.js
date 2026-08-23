// SPDX-License-Identifier: GPL-2.0-only

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const REQUEST_INITIALIZE = 0;

export class AppServerClient {
    constructor({command = '', onData = null, onStatus = null} = {}) {
        this._configuredCommand = command.trim();
        this._onData = onData;
        this._onStatus = onStatus;
        this._process = null;
        this._stdin = null;
        this._stdout = null;
        this._nextRequestId = 1;
        this._pending = new Map();
        this._rateLimits = null;
        this._usage = null;
        this._generation = 0;
    }

    get running() {
        return this._process !== null;
    }

    start() {
        if (this.running)
            return;

        const command = this._resolveCommand();
        if (!command) {
            this._emitStatus('error', 'Codex CLI was not found. Set its path in Preferences.');
            return;
        }

        try {
            this._generation++;
            const generation = this._generation;
            this._process = Gio.Subprocess.new(
                [command, 'app-server'],
                Gio.SubprocessFlags.STDIN_PIPE |
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_SILENCE
            );
            this._stdin = this._process.get_stdin_pipe();
            this._stdout = new Gio.DataInputStream({
                base_stream: this._process.get_stdout_pipe(),
                close_base_stream: true,
            });
            this._emitStatus('connecting', 'Connecting to Codex…');
            this._readNextLine(generation);
            this._send({
                method: 'initialize',
                id: REQUEST_INITIALIZE,
                params: {
                    clientInfo: {
                        name: 'gnome_codex_usage',
                        title: 'GNOME Codex Usage',
                        version: '0.1.0',
                    },
                    capabilities: {
                        optOutNotificationMethods: [
                            'thread/tokenUsage/updated',
                            'account/updated',
                        ],
                    },
                },
            });
        } catch (error) {
            this._emitStatus('error', `Unable to start Codex: ${error.message}`);
            this.stop();
        }
    }

    refresh() {
        if (!this.running) {
            this.start();
            return;
        }

        if (!this._stdin)
            return;

        this._request('account/rateLimits/read', {}, 'rateLimits');
        this._request('account/usage/read', {}, 'usage');
        this._emitStatus('refreshing', 'Refreshing usage…');
    }

    restart(command = this._configuredCommand) {
        this._configuredCommand = command.trim();
        this.stop();
        this.start();
    }

    stop() {
        this._generation++;
        this._pending.clear();

        if (this._stdin) {
            try {
                this._stdin.close(null);
            } catch (_) {
                // The app-server may already have closed the pipe.
            }
        }

        if (this._process) {
            try {
                this._process.send_signal(2);
            } catch (_) {
                this._process.force_exit();
            }
        }

        this._stdin = null;
        this._stdout = null;
        this._process = null;
    }

    _resolveCommand() {
        if (this._configuredCommand) {
            if (GLib.path_is_absolute(this._configuredCommand) &&
                GLib.file_test(this._configuredCommand, GLib.FileTest.IS_EXECUTABLE))
                return this._configuredCommand;

            return GLib.find_program_in_path(this._configuredCommand);
        }

        const fromPath = GLib.find_program_in_path('codex');
        if (fromPath)
            return fromPath;

        const home = GLib.get_home_dir();
        const candidates = [
            GLib.build_filenamev([home, '.npm-global', 'bin', 'codex']),
            GLib.build_filenamev([home, '.local', 'bin', 'codex']),
            GLib.build_filenamev([home, '.cargo', 'bin', 'codex']),
            '/usr/local/bin/codex',
            '/usr/bin/codex',
        ];

        return candidates.find(path =>
            GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)) ?? null;
    }

    _request(method, params, kind) {
        const id = this._nextRequestId++;
        this._pending.set(id, kind);
        this._send({method, id, params});
    }

    _send(message) {
        if (!this._stdin)
            return;

        try {
            const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
            this._stdin.write_all(bytes, null);
        } catch (error) {
            this._emitStatus('error', `Codex connection failed: ${error.message}`);
            this.stop();
        }
    }

    _readNextLine(generation) {
        if (!this._stdout || generation !== this._generation)
            return;

        this._stdout.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
            if (generation !== this._generation)
                return;

            try {
                const [line] = stream.read_line_finish_utf8(result);
                if (line === null) {
                    this._emitStatus('error', 'Codex app-server disconnected.');
                    this.stop();
                    return;
                }

                this._handleLine(line);
                this._readNextLine(generation);
            } catch (error) {
                this._emitStatus('error', `Unable to read Codex data: ${error.message}`);
                this.stop();
            }
        });
    }

    _handleLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch (_) {
            return;
        }

        if (message.id === REQUEST_INITIALIZE) {
            if (message.error) {
                this._emitStatus('error', message.error.message ?? 'Codex initialization failed.');
                return;
            }

            this._send({method: 'initialized', params: {}});
            this.refresh();
            return;
        }

        if (typeof message.id !== 'number')
            return;

        const kind = this._pending.get(message.id);
        if (!kind)
            return;

        this._pending.delete(message.id);
        if (message.error) {
            const detail = message.error.message ?? 'Unknown Codex error';
            this._emitStatus('error', `${kind === 'usage' ? 'Token usage' : 'Rate limits'}: ${detail}`);
            return;
        }

        if (kind === 'rateLimits')
            this._rateLimits = message.result;
        else
            this._usage = message.result;

        this._onData?.({rateLimits: this._rateLimits, usage: this._usage});
        if (this._pending.size === 0)
            this._emitStatus('ready', 'Updated just now');
    }

    _emitStatus(state, message) {
        this._onStatus?.({state, message});
    }
}
