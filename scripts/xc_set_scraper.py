#!/usr/bin/env python3
"""
xc_set_scraper.py

Kleines Skript, das sequentiell https://xeno-canto.org/annotation/set/<id>
abrufen und auswerten kann. Stoppt bei erstem 404.

Ausgabe: CSV mit id,status,title,content_length,error
Optional: Roh-HTML speichern (--save-html).
"""

from __future__ import annotations
import argparse
import json
import csv
import re
import sys
import time
from typing import Optional

try:
    # Use standard library to avoid external deps
    from urllib.request import Request, urlopen
    from urllib.error import HTTPError, URLError
except Exception:
    raise SystemExit('This script requires Python 3 and network access.')

USER_AGENT = 'AudioWorkbench-XCSetScraper/0.1 (+https://github.com/LimitlessGreen/SignaVis)'


def fetch_set_page(set_id: int, timeout: float = 10.0) -> dict:
    url = f'https://xeno-canto.org/annotation/set/{set_id}'
    req = Request(url, headers={
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
    })
    try:
        with urlopen(req, timeout=timeout) as resp:
            code = resp.getcode()
            body = resp.read()
            text = body.decode('utf-8', errors='replace')
            m = re.search(r'<title>(.*?)</title>', text, re.IGNORECASE | re.DOTALL)
            title = (m.group(1).strip() if m else '')
            return {
                'id': set_id,
                'url': url,
                'status': code,
                'title': title,
                'content_length': len(body),
                'html': text,
            }
    except HTTPError as e:
        # e.code may be 404, 500, etc.
        return {'id': set_id, 'url': url, 'status': e.code, 'error': str(e)}
    except URLError as e:
        return {'id': set_id, 'url': url, 'status': None, 'error': str(e)}
    except Exception as e:
        return {'id': set_id, 'url': url, 'status': None, 'error': str(e)}


def main(argv: Optional[list] = None) -> int:
    p = argparse.ArgumentParser(description='XC annotation set scraper — stop at first 404')
    p.add_argument('--start', '-s', type=int, default=1, help='Start ID (inclusive)')
    p.add_argument('--max', '-m', type=int, default=None, help='Optional max ID (inclusive)')
    p.add_argument('--delay', '-d', type=float, default=1.0, help='Delay between requests (s)')
    p.add_argument('--timeout', type=float, default=10.0, help='Request timeout (s)')
    p.add_argument('--out', '-o', default='xc_sets.json', help='Output file (JSON)')
    args = p.parse_args(argv)

    results = []

    def _strip_tags(s: str) -> str:
        return re.sub(r'<[^>]+>', '', s or '').strip()

    def _normalize_dash(s: str) -> str:
        if not s: return ''
        return s.replace('\u2014', '').replace('\u2013', '').replace('\xe2\x80\x94', '').strip()

    def parse_annotation_set_html(html_text: str) -> dict:
        # Parse set metadata table
        meta = {}
        meta_html_map = {}
        m = re.search(r'<h1>\s*Annotation Set\s*</h1>\s*<table[^>]*class=["\']results annotations-set["\'][^>]*>(.*?)</table>', html_text, re.IGNORECASE | re.DOTALL)
        meta_table = m.group(1) if m else ''
        if meta_table:
            rows = re.findall(r'<tr>(.*?)</tr>', meta_table, re.IGNORECASE | re.DOTALL)
            for r in rows:
                tds = re.findall(r'<td[^>]*>(.*?)</td>', r, re.IGNORECASE | re.DOTALL)
                if len(tds) >= 2:
                    key = _strip_tags(tds[0])
                    val_html = tds[1].strip()
                    val_text = _strip_tags(val_html)
                    meta[key] = _normalize_dash(val_text)
                    meta_html_map[key] = val_html

        # Parse annotations
        annotations = []
        ann_iter = re.finditer(r'<h2>\s*Annotation\s*\d+\s*</h2>\s*<table[^>]*class=["\']results annotations-set["\'][^>]*>(.*?)</table>', html_text, re.IGNORECASE | re.DOTALL)
        for idx, mm in enumerate(ann_iter, start=1):
            table_html = mm.group(1)
            rows = re.findall(r'<tr>(.*?)</tr>', table_html, re.IGNORECASE | re.DOTALL)
            ann_map = {}
            ann_map_html = {}
            for r in rows:
                tds = re.findall(r'<td[^>]*>(.*?)</td>', r, re.IGNORECASE | re.DOTALL)
                if len(tds) >= 2:
                    k = _strip_tags(tds[0])
                    v_html = tds[1].strip()
                    v_text = _strip_tags(v_html)
                    ann_map[k] = _normalize_dash(v_text)
                    ann_map_html[k] = v_html

            # Extract structured fields
            species_common = None
            species_sci = None
            species_html = ann_map_html.get('Species', '')
            m1 = re.search(r'<a[^>]*>([^<]+)</a>', species_html)
            if m1:
                species_common = m1.group(1).strip()
            m2 = re.search(r'<span[^>]*class=["\']sci-name["\'][^>]*>([^<]+)</span>', species_html)
            if m2:
                species_sci = m2.group(1).strip()

            recording_xc = None
            rec_html = ann_map_html.get('Recording', '')
            mrec = re.search(r'href=["\']?https?://xeno-canto.org/(\d+)', rec_html)
            if mrec:
                recording_xc = f"XC{mrec.group(1)}"
            else:
                # fallback to plain text
                rx = ann_map.get('Recording', '')
                if rx:
                    mxf = re.search(r'XC\s*(\d+)', rx)
                    if mxf:
                        recording_xc = f"XC{mxf.group(1)}"

            # times
            start_time = end_time = None
            t = ann_map.get('Start to end time', '')
            mt = re.search(r'([0-9]+\.?[0-9]*)\s*-\s*([0-9]+\.?[0-9]*)', t)
            if mt:
                start_time = float(mt.group(1))
                end_time = float(mt.group(2))

            # frequency
            freq_low = freq_high = None
            fstr = ann_map.get('Frequency range', '')
            mf = re.search(r'([0-9]+)\s*-\s*([0-9]+)', fstr)
            if mf:
                freq_low = int(mf.group(1))
                freq_high = int(mf.group(2))

            original_id = None
            oid = ann_map.get('Original ID', '')
            if oid and oid.isdigit():
                original_id = int(oid)

            annotations.append({
                'index': idx,
                'species_common_name': species_common or ann_map.get('Species',''),
                'scientific_name': species_sci or '',
                'annotator': ann_map.get('Annotator',''),
                'recording_xc_nr': recording_xc or '',
                'start_time': start_time,
                'end_time': end_time,
                'frequency_low': freq_low,
                'frequency_high': freq_high,
                'sound_type': ann_map.get('Sound type','') or ann_map.get('Sound type',''),
                'sex': ann_map.get('Sex',''),
                'life_stage': ann_map.get('Life stage',''),
                'remarks': ann_map.get('Remarks',''),
                'original_id': original_id,
                'raw': ann_map,
            })

        return {'metadata': meta, 'annotations': annotations}

    i = args.start
    while True:
        if args.max is not None and i > args.max:
            print('Reached --max, stopping.')
            break
        rec = fetch_set_page(i, timeout=args.timeout)
        status = rec.get('status')
            if status == 200:
                print(f"[{i}] 200 OK — title={rec.get('title')!r} len={rec.get('content_length')}")
                parsed = parse_annotation_set_html(rec.get('html',''))
                results.append({
                    'id': rec['id'],
                    'url': rec['url'],
                    'status': 200,
                    'title': rec.get('title',''),
                    'content_length': rec.get('content_length',0),
                    'metadata': parsed.get('metadata', {}),
                    'annotations': parsed.get('annotations', []),
                })
        elif status == 404:
            print(f"[{i}] 404 Not Found — stopping.")
            results.append({'id': rec['id'], 'url': rec['url'], 'status': 404, 'title': '', 'content_length': 0, 'metadata': {}, 'annotations': []})
            break
        else:
            print(f"[{i}] {status!r} — error: {rec.get('error')}")
            results.append({'id': rec['id'], 'url': rec['url'], 'status': status if status else '', 'title': '', 'content_length': 0, 'error': rec.get('error','')} )

        i += 1
        time.sleep(max(0.01, args.delay))

    # Write combined JSON output
    try:
        with open(args.out, 'w', encoding='utf-8') as outfh:
            json.dump(results, outfh, ensure_ascii=False, indent=2)
        print(f"Results written to {args.out}")
    except Exception as e:
        print(f"Could not write output file {args.out}: {e}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
