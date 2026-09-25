import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


SAVER = Path.home() / '.local/bin/kitty-save-session'
CONFIG = Path.home() / '.config/kitty/kitty.conf'


def main():
    with tempfile.TemporaryDirectory(prefix='kitty-layout-restore-') as directory:
        root = Path(directory)
        processes = []
        env = dict(os.environ, HOME=str(root), KITTY_CONFIG_DIRECTORY=str(root / '.config/kitty'))
        for key in ('KITTY_LISTEN_ON', 'KITTY_WINDOW_ID', 'KITTY_PID', 'WAYLAND_DISPLAY'):
            env.pop(key, None)
        config_dir = root / '.config/kitty'
        config_dir.mkdir(parents=True)
        shutil.copy2(CONFIG.parent / 'tab_bar.py', config_dir / 'tab_bar.py')
        log = (root / 'log').open('w+')

        def run(args, **kwargs):
            return subprocess.run(args, env=env, capture_output=True, text=True,
                                  check=True, timeout=15, **kwargs).stdout.strip()

        def wait(check):
            until = time.monotonic() + 15
            while time.monotonic() < until:
                try:
                    value = check()
                    if value:
                        return value
                except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
                    pass
                time.sleep(0.1)
            raise AssertionError('Isolated Kitty did not become ready')

        def rc(socket, *args):
            return run(['kitten', '@', '--to', socket, *args])

        def windows(socket):
            return json.loads(rc(socket, 'ls'))[0]['tabs'][0]['windows']

        def start(name, session=None):
            socket = f'unix:{root}/{name}.sock'
            args = ['kitty', '--config', str(CONFIG), '--override', 'startup_session=none',
                    '--override', 'linux_display_server=x11', '--override', 'update_check_interval=0',
                    '--override', 'remember_window_size=no', '--override', 'initial_window_width=1200',
                    '--override', 'initial_window_height=800', '--listen-on', socket]
            if session:
                args += ['--session', str(session)]
            else:
                args += ['--title', 'A', '/bin/sleep', '3600']
            process = subprocess.Popen(args, env=env, stdout=log, stderr=log)
            processes.append(process)
            wait(lambda: windows(socket))
            return process, socket

        def save(socket, name):
            run_env = dict(env, KITTY_LISTEN_ON=socket)
            subprocess.run([str(SAVER), '--auto'], env=run_env, capture_output=True,
                           text=True, check=True, timeout=20)
            target = root / f'{name}.kitty'
            shutil.copy2(config_dir / 'last-session.kitty', target)
            return target

        def layout(path):
            lines = path.read_text().splitlines()
            state = json.loads(next(line.partition(' ')[2] for line in lines
                                    if line.startswith('set_layout_state ')))
            return state['pairs']

        def normalized(pair, identities):
            if isinstance(pair, int):
                return identities[pair]
            axis = pair.get('horizontal', True)
            assert type(axis) is bool, f'Orientation is not boolean: {axis!r}'
            return (axis, pair.get('bias', 0.5),
                    normalized(pair['one'], identities), normalized(pair['two'], identities))

        def geometry(items):
            return {w['user_vars']['fixture']: (w['columns'], w['lines']) for w in items}

        def stop(process):
            process.terminate()
            process.wait(timeout=10)

        try:
            read_fd, write_fd = os.pipe()
            xvfb = subprocess.Popen(['Xvfb', '-displayfd', str(write_fd), '-screen', '0', '1280x900x24',
                                     '-nolisten', 'tcp'], pass_fds=(write_fd,), stdout=log, stderr=log)
            processes.append(xvfb)
            os.close(write_fd)
            with os.fdopen(read_fd) as display:
                env['DISPLAY'] = ':' + display.readline().strip()
            original, socket = start('original')
            a = windows(socket)[0]['id']
            rc(socket, 'set-user-vars', '--match', f'id:{a}', 'fixture=A')

            def split(label, target, location, bias):
                rc(socket, 'focus-window', '--match', f'id:{target}')
                return int(rc(socket, 'launch', '--title', label, '--var', f'fixture={label}',
                              '--location', location, '--bias', str(bias), '/bin/sleep', '3600'))

            b = split('B', a, 'vsplit', 63)
            split('C', a, 'hsplit', 37)
            d = split('D', b, 'hsplit', 68)
            split('E', d, 'vsplit', 41)
            initial = windows(socket)
            identities = {w['id']: w['user_vars']['fixture'] for w in initial}
            expected_geometry = geometry(initial)
            native = root / 'native.kitty'
            rc(socket, 'action', 'save_as_session', '--save-only', '--use-foreground-process', str(native))
            expected = normalized(layout(native), identities)
            assert 'False' in repr(expected) and 'True' in repr(expected)
            assert any(w['columns'] != initial[0]['columns'] for w in initial)
            saved = save(socket, 'saved-0')
            assert normalized(layout(saved), identities) == expected
            stop(original)
            for cycle in (1, 2):
                process, socket = start(f'restored-{cycle}', saved)
                restored = wait(lambda: (items if len(items := windows(socket)) == 5 else None))
                assert set(w['user_vars']['fixture'] for w in restored) == set(expected_geometry)
                assert geometry(restored) == expected_geometry, (geometry(restored), expected_geometry)
                assert all(w['cmdline'] == ['/bin/sleep', '3600'] for w in restored)
                saved = save(socket, f'saved-{cycle}')
                identities = {w['id']: w['user_vars']['fixture'] for w in restored}
                assert normalized(layout(saved), identities) == expected
                stop(process)
            print('PASS real Kitty: five pane identities/order/cell sizes, nested mixed axes and unequal biases, two restore/save cycles')
        except BaseException:
            log.flush()
            print((root / 'log').read_text()[-2000:])
            raise
        finally:
            for process in reversed(processes):
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
            log.close()


if __name__ == '__main__':
    main()
