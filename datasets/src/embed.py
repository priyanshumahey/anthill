import argparse
import json
import os
import time

import chromadb
import numpy as np
from llama_cpp import Llama

from pdf import extract_text

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
MODEL_PATH = os.path.join(_ROOT, "models/harrier-oss-v1-270M-Q8_0.gguf")
PAPERS_JSON = os.path.join(_ROOT, "papers.json")
CHROMA_DIR = os.path.join(_ROOT, "chroma_db")
COLLECTION_NAME = "papers"
CHUNK_SIZE = 512  # words per chunk
CHUNK_OVERLAP = 64  # words overlap


def chunk_text_with_offsets(text, chunk_size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    """Split text into word-windowed chunks; return [(chunk_str, char_start, char_end)]."""
    words = text.split()
    if not words:
        return []

    # Compute char offset for each word in the original text by re-walking.
    word_offsets = []
    cursor = 0
    for w in words:
        idx = text.find(w, cursor)
        if idx < 0:
            idx = cursor
        word_offsets.append(idx)
        cursor = idx + len(w)

    chunks = []
    start = 0
    while start < len(words):
        end = min(start + chunk_size, len(words))
        chunk_words = words[start:end]
        chunk_str = " ".join(chunk_words)
        char_start = word_offsets[start]
        last = end - 1
        char_end = word_offsets[last] + len(words[last])
        chunks.append((chunk_str, char_start, char_end))
        if end == len(words):
            break
        start += chunk_size - overlap
    return chunks


def load_model():
    print(f"Loading model: {MODEL_PATH}")
    t0 = time.time()
    model = Llama(
        model_path=MODEL_PATH,
        embedding=True,
        n_ctx=0,
        n_batch=2048,
        n_ubatch=2048,
        n_gpu_layers=-1,
        verbose=False,
    )
    print(f"Model loaded in {time.time() - t0:.1f}s")
    return model


def embed_texts(model, texts):
    results = model.create_embedding(texts)
    embeddings = np.array(
        [item["embedding"] for item in results["data"]],
        dtype=np.float32,
    )
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1
    return embeddings / norms


def get_chroma_collection():
    client = chromadb.PersistentClient(path=CHROMA_DIR)
    return client.get_or_create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )


def _embed_and_store(model, collection, arxiv_id, title, text):
    chunks = chunk_text_with_offsets(text)
    if not chunks:
        print(f"  no chunks (empty text), skipping")
        return
    print(f"  {len(chunks)} chunks ({len(text):,} chars)")

    t0 = time.time()
    # llama-cpp's batched embedding path errors on this model; embed one at a time.
    all_embeddings = []
    for c in chunks:
        emb = embed_texts(model, [c[0]])
        all_embeddings.append(emb)
    embeddings = np.concatenate(all_embeddings, axis=0)
    elapsed = time.time() - t0
    print(f"  Embedded in {elapsed:.2f}s ({len(chunks) / max(elapsed, 1e-6):.1f} chunks/s)")

    ids = [f"{arxiv_id}__chunk_{j}" for j in range(len(chunks))]
    documents = [c[0] for c in chunks]
    metadatas = [
        {
            "arxiv_id": arxiv_id,
            "title": title,
            "chunk_index": j,
            "char_start": c[1],
            "char_end": c[2],
        }
        for j, c in enumerate(chunks)
    ]
    collection.add(
        ids=ids,
        embeddings=embeddings.tolist(),
        documents=documents,
        metadatas=metadatas,
    )
    print(f"  Stored {len(chunks)} chunks in ChromaDB")


def embed_from_json(model, papers_json=PAPERS_JSON):
    with open(papers_json) as f:
        papers = json.load(f)

    collection = get_chroma_collection()

    embedded = 0
    skipped = 0
    failed = 0
    for i, paper in enumerate(papers):
        arxiv_id = paper["arxiv_id"]
        title = paper["title"]
        text = paper.get("full_text")

        if not text:
            pdf_path = paper.get("pdf_path")
            if pdf_path and os.path.isfile(pdf_path):
                try:
                    text = extract_text(pdf_path)
                except Exception as e:
                    print(f"[{i+1}/{len(papers)}] {arxiv_id}: extract failed: {e}")
                    failed += 1
                    continue
            else:
                print(f"[{i+1}/{len(papers)}] {arxiv_id}: no text, skipping")
                skipped += 1
                continue

        existing = collection.get(where={"arxiv_id": arxiv_id}, limit=1)
        if existing["ids"]:
            print(f"[{i+1}/{len(papers)}] {arxiv_id}: already embedded, skipping")
            skipped += 1
            continue

        print(f"[{i+1}/{len(papers)}] {arxiv_id}: {title[:80]}")
        try:
            _embed_and_store(model, collection, arxiv_id, title, text)
            embedded += 1
        except Exception as e:
            print(f"  embed failed: {e}")
            failed += 1

    print(
        f"\nDone. embedded={embedded} skipped={skipped} failed={failed}. "
        f"Collection has {collection.count()} total chunks."
    )


def query_papers(model, query_text, n_results=5):
    collection = get_chroma_collection()

    if collection.count() == 0:
        print("No embeddings found. Run `embed` first.")
        return

    instruction = (
        "Instruct: Given a scientific query, retrieve relevant paper passages\n"
        "Query: "
    )
    query_emb = embed_texts(model, [instruction + query_text])

    results = collection.query(
        query_embeddings=query_emb.tolist(),
        n_results=n_results,
    )

    print(f"\nQuery: {query_text}")
    print(f"Top {len(results['ids'][0])} results:\n")

    for rank, (doc_id, doc, metadata, distance) in enumerate(zip(
        results["ids"][0],
        results["documents"][0],
        results["metadatas"][0],
        results["distances"][0],
    )):
        score = (1 - distance) * 100
        print(f"  [{rank+1}] Score: {score:.1f}  arxiv={metadata.get('arxiv_id')}  chunk={metadata.get('chunk_index')}")
        print(f"      Title: {(metadata.get('title') or '')[:90]}")
        print(f"      Text:  {doc[:200].replace(chr(10), ' ')}...")
        print()


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("embed", help="Embed all papers in papers.json into Chroma")
    e.add_argument("--papers", default=PAPERS_JSON)

    q = sub.add_parser("query", help="Run a semantic query against the collection")
    q.add_argument("text")
    q.add_argument("-k", type=int, default=5, dest="n_results")

    args = ap.parse_args()
    model = load_model()
    if args.cmd == "embed":
        embed_from_json(model, papers_json=args.papers)
    elif args.cmd == "query":
        query_papers(model, args.text, n_results=args.n_results)


if __name__ == "__main__":
    main()
