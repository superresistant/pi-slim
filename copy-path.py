import subprocess
import sys
from urllib.parse import unquote


def copy_path(url):
    prefix = "pi-slim-copy:"
    if not url.startswith(prefix):
        raise ValueError("Expected a pi-slim-copy link")
    path = unquote(url[len(prefix):], errors="strict")
    if not path.startswith("/") or "\0" in path:
        raise ValueError("Expected an absolute cwd")
    subprocess.run(["xclip", "-selection", "clipboard"], input=path.encode("utf-8"), check=True)


if __name__ == "__main__":
    copy_path(sys.argv[1])
