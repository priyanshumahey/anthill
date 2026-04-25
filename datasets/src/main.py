import argparse
import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

import arxiv
import requests

from pdf import extract_text

# Default query: search relevance / IR / retrieval flavored AI papers.
DEFAULT_QUERY = (
    '(cat:cs.IR OR cat:cs.AI) AND '
    '(abs:"information retrieval" OR abs:"search relevance" OR '
    'abs:"semantic search" OR abs:ranking OR abs:retrieval)'
)
OUTPUT_FILE = "papers.json"
PDF_DIR = "papers"


def get_arxiv_id(result):
    return result.entry_id.split("/abs/")[-1]


def strip_version(arxiv_id):
    return arxiv_id.split("v")[0] if "v" in arxiv_id else arxiv_id


def reconstruct_abstract(inv_idx):
    if not inv_idx:
        return None
    words = []
    for word, positions in inv_idx.items():
        for pos in positions:
            words.append((pos, word))
    words.sort()
    return " ".join(w for _, w in words)


def batch_openalex_lookup(session, arxiv_ids):
    BATCH_SIZE = 50
    results = {}
    for batch_start in range(0, len(arxiv_ids), BATCH_SIZE):
        batch = arxiv_ids[batch_start:batch_start + BATCH_SIZE]
        doi_filter = "|".join(
            f"https://doi.org/10.48550/arXiv.{strip_version(aid)}"
            for aid in batch
        )
        try:
            resp = session.get(
                "https://api.openalex.org/works",
                params={
                    "filter": f"doi:{doi_filter}",
                    "per_page": BATCH_SIZE,
                    "mailto": os.environ.get("OPENALEX_EMAIL", ""),
                },
                timeout=30,
            )
        except requests.RequestException as e:
            print(f"  OpenAlex batch failed: {e}")
            continue
        if resp.status_code != 200:
            continue
        for data in resp.json().get("results", []):
            doi = (data.get("doi") or "").lower()
            if "arxiv." in doi:
                aid = doi.split("arxiv.")[-1]
                results[aid] = _parse_openalex(data)
    return results


def _parse_openalex(data):
    return {
        "openalex_id": data.get("id"),
        "doi": data.get("doi"),
        "title": data.get("title"),
        "abstract": reconstruct_abstract(data.get("abstract_inverted_index")),
        "year": data.get("publication_year"),
        "authors": [
            a["author"]["display_name"]
            for a in data.get("authorships", [])
        ],
        "venue": (
            data["primary_location"]["source"]["display_name"]
            if data.get("primary_location") and data["primary_location"].get("source")
            else None
        ),
        "citations": data.get("cited_by_count"),
        "topics": [t["display_name"] for t in data.get("topics", [])],
    }


def download_and_extract(result, pdf_dir):
    arxiv_id = get_arxiv_id(result)
    try:
        pdf_path = result.download_pdf(dirpath=pdf_dir)
        full_text = extract_text(str(pdf_path))
        return arxiv_id, str(pdf_path), full_text, None
    except Exception as e:
        return arxiv_id, None, None, str(e)


def load_existing(path):
    if not os.path.isfile(path):
        return []
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return []


def save_papers(path, papers):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(papers, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def fetch(query=DEFAULT_QUERY, max_results=1000, output_file=OUTPUT_FILE,
          pdf_dir=PDF_DIR, save_every=25):
    """Fetch papers from arXiv. Resumes by skipping arxiv_ids already in output_file."""
    os.makedirs(pdf_dir, exist_ok=True)

    existing = load_existing(output_file)
    seen_ids = {strip_version(p["arxiv_id"]) for p in existing}
    print(f"Resuming with {len(existing)} existing papers ({len(seen_ids)} unique ids).")

    client = arxiv.Client(page_size=100, delay_seconds=3.0, num_retries=5)
    search = arxiv.Search(
        query=query,
        max_results=max_results,
        sort_by=arxiv.SortCriterion.Relevance,
    )

    print(f"Querying arXiv: {query}")
    print(f"Requesting up to {max_results} results...")

    new_results = []
    for r in client.results(search):
        aid = get_arxiv_id(r)
        if strip_version(aid) in seen_ids:
            continue
        seen_ids.add(strip_version(aid))
        new_results.append(r)

    print(f"Got {len(new_results)} new results from arXiv (after dedupe)")
    if not new_results:
        return existing

    papers = list(existing)

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {
            pool.submit(download_and_extract, r, pdf_dir): r
            for r in new_results
        }
        completed = 0
        for future in as_completed(futures):
            r = futures[future]
            arxiv_id, pdf_path, full_text, err = future.result()
            completed += 1
            if err:
                print(f"  [{completed}/{len(new_results)}] FAIL {arxiv_id}: {err}")
                continue
            paper = {
                "arxiv_id": arxiv_id,
                "title": r.title,
                "abstract": r.summary,
                "full_text": full_text,
                "pdf_path": pdf_path,
                "authors": [a.name for a in r.authors],
                "published": r.published.isoformat(),
                "updated": r.updated.isoformat() if r.updated else None,
                "categories": r.categories,
                "pdf_url": r.pdf_url,
                "arxiv_url": r.entry_id,
            }
            papers.append(paper)
            print(f"  [{completed}/{len(new_results)}] OK {arxiv_id} ({len(full_text or ''):,} chars)")

            if completed % save_every == 0:
                save_papers(output_file, papers)
                print(f"  -> checkpoint: saved {len(papers)} papers")

    save_papers(output_file, papers)

    # OpenAlex enrichment for any paper missing the openalex field.
    print("\nEnriching with OpenAlex metadata (papers missing it)...")
    needs = [p["arxiv_id"] for p in papers if "openalex" not in p]
    if needs:
        session = requests.Session()
        oa_map = batch_openalex_lookup(session, needs)
        print(f"  Found {len(oa_map)}/{len(needs)} on OpenAlex")
        for p in papers:
            md = oa_map.get(strip_version(p["arxiv_id"]))
            if md:
                p["openalex"] = md
        save_papers(output_file, papers)

    print(f"\nSaved {len(papers)} papers to {output_file}")
    return papers


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("fetch", help="Fetch papers from arXiv")
    f.add_argument("--query", default=DEFAULT_QUERY)
    f.add_argument("--max", type=int, default=1000, dest="max_results")
    f.add_argument("--output", default=OUTPUT_FILE)
    f.add_argument("--pdf-dir", default=PDF_DIR)
    f.add_argument("--save-every", type=int, default=25)

    args = ap.parse_args()
    if args.cmd == "fetch":
        fetch(
            query=args.query,
            max_results=args.max_results,
            output_file=args.output,
            pdf_dir=args.pdf_dir,
            save_every=args.save_every,
        )


if __name__ == "__main__":
    main()
