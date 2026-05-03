# Unsloth-Training-Config

Scripts zum Training von **Mistral-Small-3.2-24B-Instruct-2506** auf JSONL-Exports der Fine-Tuning-Karte. Optimiert für **1× RTX 4000 Ada (20 GB)**.

Zwei Wege:

- **Unsloth Studio** (UI, kein Python-Setup) – siehe [Studio-Route](#unsloth-studio).
- **CLI** – Script [`train_book.py`](train_book.py), Training + Merge + GGUF-Export in einem.

## Inhalt

| Datei | Zweck |
|---|---|
| [`studio-config.yaml`](studio-config.yaml) | YAML-Import für Unsloth Studio (Studio-Key-Schema) |
| [`train_book.py`](train_book.py) | CLI-Script: Training, Merge, GGUF |
| [`requirements.txt`](requirements.txt) | Gepinnte Versionen (CLI-Pfad) |
| [`Modelfile.example`](Modelfile.example) | Ollama-Modelfile |

## Setup

```bash
conda create -n unsloth python=3.11 -y
conda activate unsloth
pip install -r requirements.txt
```

Voraussetzung: CUDA 12.1+, GPU sichtbar (`python -c "import torch; print(torch.cuda.is_available())"` → `True`).

## Daten

Export aus der UI mit:

- Alle fünf Typen aktiv.
- `Max. Token pro Sample = 4096`.
- `Vorgerendertes text-Feld = aus` (Studio/Script rendern selbst).

`train.jsonl` und `val.jsonl` in diesen Ordner legen.

## Unsloth Studio

### Variante A: YAML-Import

1. Studio starten:
   ```bash
   pip install unsloth
   unsloth studio -H 0.0.0.0 -p 8888
   ```
   `http://localhost:8888` öffnen.
2. **Model-Tab:** `unsloth/Mistral-Small-3.2-24B-Instruct-2506-unsloth-bnb-4bit`, Method **QLoRA**.
3. **Dataset-Tab:** `train.jsonl` + `val.jsonl` hochladen (Format `messages`).
4. **Training & Config:** **Import YAML** → [`studio-config.yaml`](studio-config.yaml).
5. Prüfen: `train_on_completions: true` aktiv (wichtig – ohne verwässert der Stil).
6. **Start.** Erwartung: `eval_loss` fällt in ~500 Steps auf 1.4–1.8.
7. **Export → GGUF Q5_K_M.**

Studio nutzt eigene Key-Namen (nicht HuggingFace TrainingArguments). Falsche Keys werden **stumm ignoriert**:

| HF-/Axolotl | Studio |
|---|---|
| `train_on_responses_only` | `train_on_completions` |
| `warmup_ratio` | `warmup_steps` (absolut) |
| `num_train_epochs` | `num_epochs` |
| `per_device_train_batch_size` | `batch_size` |
| `seed` | `random_seed` |
| `lora.r` | `lora.lora_r` |

### Variante B: GUI manuell

**Dataset:** Upload `train.jsonl` + `val.jsonl`. Basemodell `unsloth/Mistral-Small-3.2-24B-Instruct-2506-unsloth-bnb-4bit`, Method QLoRA.

**Parameters:**

| Feld | Wert |
|---|---|
| Use Epochs | 2 |
| Context Length | 4096 |
| Learning Rate | 0.0002 |

**LoRA:** Rank 32, Alpha 32, Dropout 0, alle sieben Target-Module aktiv.

**Optimization:** AdamW 8-bit, Cosine, Batch 1, Grad Accum 16, Weight Decay 0.001.

**Schedule:** Warmup Ratio 0.03.

**Memory:** bf16, Gradient Checkpointing **an**, Sample Packing **aus**.

**Train on Completions:** **an**.

**Mistral-3.2 Layer-Auswahl (Advanced):**

- Vision layers **aus** (Pixtral-Encoder ohne Bilddaten – sonst Korruption).
- Language layers **an**, Attention **an**, MLP **an**.

**Export:** GGUF Q5_K_M.

## Run: Single-GPU CLI

```bash
cd docs/unsloth-config
CUDA_VISIBLE_DEVICES=0 python train_book.py
```

GPU 1 bleibt frei für paralleles Ollama (`CUDA_VISIBLE_DEVICES=1 ollama serve`).

**Laufzeit:** ~30 000 Samples, seq_len 4096, 2 Epochen → 18–28 h.

**Monitoring:** `tensorboard --logdir runs/mistral-small32-buch`. Wichtige Kurve `eval/loss`. Start ~1.8–2.4 → 500–1500 Steps → ~1.1–1.5 → stabilisiert. Steigt eval/loss → Early-Stopping (Callback aktiv, stoppt nach 3 Plateaus).

**Ausgabe:**

```
runs/mistral-small32-buch/
├── checkpoint-XXXX/   # max. 3 (save_total_limit)
├── adapter/           # LoRA (~400 MB)
├── merged/            # bf16 (~48 GB)
└── gguf/
    └── unsloth.Q4_K_M.gguf   # ~14 GB
```

## In Ollama einbinden

```bash
cd runs/mistral-small32-buch/gguf
# Modelfile.example: BOOK_TITLE im SYSTEM-Feld setzen
ollama create buch-autor -f ../../../Modelfile.example
ollama run buch-autor "Schreibe den Anfang eines neuen Kapitels."
```

`.env` der bookstack-lektorat-App:

```
API_PROVIDER=ollama
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=buch-autor
OLLAMA_TEMPERATURE=0.8
```

Server neu starten.

## Run: Multi-GPU DDP (optional, unofficial)

Unsloth-OSS unterstützt Multi-GPU nicht offiziell, DDP funktioniert in der Praxis. Bei 2 GPUs `gradient_accumulation_steps` von 16 auf 8 senken (effektive Batch bleibt 16).

```bash
accelerate launch \
    --num_processes 2 \
    --num_machines 1 \
    --mixed_precision bf16 \
    train_book.py
```

Speed-Up ~1.7× (PCIe-Sync-Overhead).

## Troubleshooting

### OOM

1. `max_seq_length = 2048` im Script.
2. Export neu mit `max_seq_tokens=2048`.
3. `r=16, alpha=16` (statt 32/32).

### `[INST] not found in tokens`

Chat-Template passt nicht. Check:

```python
print(tokenizer.apply_chat_template(
    [{"role": "user", "content": "test"}], tokenize=False))
```

Soll `<s>[INST] test [/INST]` enthalten. Sonst `instruction_part`/`response_part` im Script anpassen.

### `ModuleNotFoundError: triton`

```bash
pip install triton==3.0.0
```

### GGUF-Export hängt

`save_pretrained_gguf` baut llama.cpp aus Source (~5 min, braucht `cmake` + `g++`). Alternative: GGUF-Zeile auskommentieren, später manuell via `convert_hf_to_gguf.py`.

### Eval-Loss fällt nicht

- LR halbieren (2e-4 → 1e-4).
- `r` erhöhen (32 → 48/64).
- `train_on_responses_only` aktiv?

### Klingt wie vorher

- `num_train_epochs = 3`.
- Datensatz < 5000 Samples → kaum messbarer Effekt.
- Komplettanalyse vorher gelaufen, alle Export-Typen aktiv?

## Aufräumen

```bash
rm -rf runs/mistral-small32-buch/checkpoint-*
rm -rf runs/mistral-small32-buch/merged   # nur bei reinem Ollama-Einsatz
```
