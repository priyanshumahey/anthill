import os
import tempfile

import arxiv

from pdf import extract_pages


def download_arxiv_pdf(arxiv_id, dest_dir):
    clean_id = arxiv_id.replace("arxiv:", "").strip()
    client = arxiv.Client()
    search = arxiv.Search(id_list=[clean_id])
    result = next(client.results(search))
    pdf_path = result.download_pdf(dirpath=dest_dir)
    return pdf_path, result


def read_paper(source, save=None):
    if os.path.isfile(source):
        print(f"Reading local PDF: {source}")
        pdf_path = source
        title = os.path.basename(source)
        tmpdir = None
    else:
        print(f"Downloading arXiv paper: {source}")
        tmpdir = tempfile.mkdtemp()
        pdf_path, result = download_arxiv_pdf(source, tmpdir)
        title = result.title
        print(f"Title: {title}")
        print(f"Authors: {', '.join(a.name for a in result.authors)}")
        print(f"Published: {result.published.date()}")
        print(f"PDF saved to: {pdf_path}")

    print(f"Extracting text...")
    pages = extract_pages(pdf_path)

    total_chars = sum(len(p["text"]) for p in pages)
    total_words = sum(len(p["text"].split()) for p in pages)
    print(f"Extracted {len(pages)} pages, {total_words:,} words, {total_chars:,} chars")

    if save:
        full_text = "\n\n".join(
            f"=== Page {p['page']} ===\n{p['text']}" for p in pages
        )
        header = f"Title: {title}\nPages: {len(pages)}\nWords: {total_words}\n\n"
        with open(save, "w") as f:
            f.write(header + full_text)
        print(f"Full text saved to {save}")

    if tmpdir:
        os.remove(pdf_path)
        os.rmdir(tmpdir)

    return pages
