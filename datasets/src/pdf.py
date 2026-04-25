import fitz


def extract_text(pdf_path):
    with fitz.open(pdf_path) as doc:
        return "\n".join(page.get_text() for page in doc)


def extract_pages(pdf_path):
    with fitz.open(pdf_path) as doc:
        return [{"page": i + 1, "text": page.get_text()} for i, page in enumerate(doc)]
