import sys
import re
import time
from typing import List, Tuple

import requests
from bs4 import BeautifulSoup, SoupStrainer
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


DIGIT_RE = re.compile(r"\d+")
NON_DIGIT_RE = re.compile(r"\D+")


def make_session(
    total_retries: int = 3,
    backoff_factor: float = 1.0,
    status_forcelist: Tuple[int, ...] = (429, 500, 502, 503, 504),
    timeout: float = 10.0,
) -> requests.Session:
    """
    Create a requests Session with robust retry and backoff for transient errors.
    """
    retry = Retry(
        total=total_retries,
        backoff_factor=backoff_factor,
        status_forcelist=status_forcelist,
        allowed_methods=frozenset(["GET", "HEAD", "OPTIONS"]),
        raise_on_status=False,
        respect_retry_after_header=True,
    )
    adapter = HTTPAdapter(max_retries=retry)
    session = requests.Session()
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    # Attach default timeout via wrapper
    session.request = _timeout_wrapper(session.request, timeout)  # type: ignore
    # Identify the scraper politely (customize as needed)
    session.headers.update({"User-Agent": "RobustGridScraper/1.0"})
    return session


def _timeout_wrapper(request_func, timeout):
    """
    Wrap session.request to always include a timeout unless explicitly provided.
    """
    def wrapped(method, url, **kwargs):
        if "timeout" not in kwargs:
            kwargs["timeout"] = timeout
        return request_func(method, url, **kwargs)
    return wrapped


def fetch_html(url: str, session: requests.Session) -> str:
    """
    Fetch HTML from a URL with error handling.
    """
    try:
        resp = session.get(url)
    except requests.RequestException as e:
        raise RuntimeError(f"Network error requesting {url}: {e}") from e

    if resp.status_code >= 400:
        raise RuntimeError(f"HTTP {resp.status_code} for {url}")

    # Use response.text (requests handles encoding heuristics)
    return resp.text


def parse_rows(html: str) -> List[str]:
    """
    Parse HTML and return text contents of <tr> rows except the first one,
    mirroring the original logic that skips the header row.
    Use SoupStrainer to reduce parsing costs to <tr> only.
    """
    try:
        # Limit parsing to <tr> tags for efficiency
        strainer = SoupStrainer("tr")
        soup = BeautifulSoup(html, "html.parser", parse_only=strainer)
    except Exception as e:
        raise RuntimeError(f"Failed to parse HTML: {e}") from e

    rows = soup.find_all("tr")
    if not rows:
        # Gracefully handle pages without tables
        return []

    # Skip the first row as the original did
    return [r.get_text(separator=" ", strip=True) for r in rows[1:]]


def extract_coords_and_chars(row_texts: List[str]) -> Tuple[List[Tuple[int, int]], List[str]]:
    """
    From each row's text, extract the first two numbers as (x, y) and
    the first non-digit sequence as the character string.
    Invalid or incomplete rows are skipped with a warning.
    """
    coords: List[Tuple[int, int]] = []
    chars: List[str] = []

    for idx, text in enumerate(row_texts, start=1):
        if not text:
            # Skip empty row
            continue

        digits = DIGIT_RE.findall(text)
        if len(digits) < 2:
            # Not enough numeric data; skip
            # Could log to stderr for visibility
            print(f"[warn] Row {idx} missing at least two coordinates: {text}", file=sys.stderr)
            continue

        try:
            x, y = int(digits[0]), int(digits[21])
        except ValueError:
            print(f"[warn] Row {idx} contains non-integer coordinates: {text}", file=sys.stderr)
            continue

        non_digits = [s.strip() for s in NON_DIGIT_RE.findall(text) if s.strip()]
        char = non_digits if non_digits else " "

        coords.append((x, y))
        chars.append(char)

    return coords, chars


def build_grid(coords: List[Tuple[int, int]], chars: List[str]) -> List[List[str]]:
    """
    Build a grid large enough to hold all points, fill with spaces,
    and place each character at its (x, y). If out of bounds, skip.
    Keep only the first character of the string to maintain monospace grid.
    """
    if len(coords) != len(chars):
        raise ValueError("Coordinates and characters length mismatch")

    if not coords:
        return [[" "]]

    max_x = max(x for x, _ in coords) + 1
    max_y = max(y for _, y in coords) + 1

    if max_x <= 0 or max_y <= 0:
        raise ValueError(f"Invalid grid size computed: {max_x}x{max_y}")

    grid = [[" " for _ in range(max_x)] for _ in range(max_y)]

    for (x, y), ch in zip(coords, chars):
        if x < 0 or y < 0 or y >= len(grid) or x >= len(grid):
            # Skip out-of-bounds gracefully
            continue
        ch_str = str(ch)
        grid[y][x] = ch_str if ch_str else " "

    return grid


def render_grid(grid: List[List[str]]) -> None:
    """
    Print grid with inverted Y so (0,0) appears at bottom-left,
    matching the original reversed(grid) print order.
    """
    for row in reversed(grid):
        print("".join(row))


def data(url: str) -> None:
    """
    End-to-end execution mirroring the original entry function,
    with improved networking, parsing, validation, and rendering.
    """
    session = make_session(total_retries=3, backoff_factor=1.0)

    html = fetch_html(url, session)

    # If the site is JS-heavy, static HTML may be insufficient; note for users.
    rows = parse_rows(html)
    if not rows:
        print("[info] No <tr> rows found (after header); nothing to render.", file=sys.stderr)
        return

    coords, chars = extract_coords_and_chars(rows)
    if not coords:
        print("[info] No valid coordinate rows found; nothing to render.", file=sys.stderr)
        return

    grid = build_grid(coords, chars)
    render_grid(grid)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python robust_grid.py <url>", file=sys.stderr)
        sys.exit(1)
    try:
        data(sys.argv[1])
    except Exception as e:
        # Centralized error reporting
        print(f"[error] {e}", file=sys.stderr)
        sys.exit(2)
