# Fine-Tuning auf den Exportdaten

Vom JSONL-Export der Fine-Tuning-Karte zu einem lokal laufenden Modell, das Stil, Welt und Figuren des Buchs internalisiert.

**Pfad:** [Unsloth](https://github.com/unslothai/unsloth) + QLoRA mit Mistral-Small-3.2-24B als Basis. Web-UI ([Unsloth Studio](https://studio.unsloth.ai)) oder CLI-Script ([train_book.py](unsloth-config/train_book.py)). Optimiert für 1× RTX 4000 Ada (20 GB).

## 1. Modell und Hardware

**Basemodell:** `unsloth/Mistral-Small-3.2-24B-Instruct-2506-unsloth-bnb-4bit`. Native DE-Kompetenz, 128 k Context, `[INST]`/`[/INST]`-Template (Tekken-V7), GGUF-Export für Ollama.

**Hardware:** 20 GB VRAM reichen für QLoRA mit:

- `max_seq_length = 4096` (bei OOM: 2048)
- `per_device_train_batch_size = 1`
- `gradient_accumulation_steps = 16` → effektive Batch 16
- VRAM-Peak ~17–19 GB

## 2. Daten exportieren

UI → Buch → Kachel **Fine-Tuning-Export**:

- Alle fünf Typen aktiv: `Stil`, `Szene`, `Dialog`, `Autor-Chat`, `Korrekturen`.
- `Min. Zeichen = 200`, `Max. Zeichen = 4000`.
- `Validation-Split = 0.05` (> 20 000 Samples), sonst `0.1`.
- `Max. Token pro Sample = 4096`.
- `Vorgerendertes text-Feld` optional.

Stats nach Generierung: p95/max Token, empfohlene `seq_len`, verworfene Samples.

Format pro Zeile:

```json
{"messages":[
  {"role":"system","content":"Du bist die Stimme des Autors von «…» …"},
  {"role":"user","content":"Wer ist Hans Meier?"},
  {"role":"assistant","content":"Hans Meier ist der Protagonist …"}
]}
```

Validieren:

```bash
wc -l train.jsonl val.jsonl
python3 -c "import json; [json.loads(l) for l in open('train.jsonl')]; print('OK')"
```

## 3. Training

Konfiguration: [docs/unsloth-config/](unsloth-config/) – Script, gepinnte Requirements, Studio-YAML, Ollama-Modelfile. Setup-/Run-Anleitung dort.

Kurzform CLI:

```bash
conda create -n unsloth python=3.11 -y && conda activate unsloth
pip install -r docs/unsloth-config/requirements.txt
cp ~/Downloads/{train,val}.jsonl docs/unsloth-config/
cd docs/unsloth-config
CUDA_VISIBLE_DEVICES=0 python train_book.py
```

Output am Ende: `runs/mistral-small32-buch/gguf/*.gguf`.

In Ollama einbinden:

```bash
cd runs/mistral-small32-buch/gguf
ollama create buch-autor -f ../../../Modelfile.example
ollama run buch-autor "Schreibe den Anfang eines neuen Kapitels."
```

## 4. Hyperparameter nach Ziel

| Ziel | `r` | `lr` | Epochen | Inferenz-Temp |
|---|---|---|---|---|
| Stilimitation (leicht) | 16 | 2e-4 | 1–2 | 0.7–0.8 |
| **Welt internalisieren (Default)** | **32** | **2e-4** | **2** | **0.7–0.85** |
| Faktenwiedergabe | 64 | 1e-4 | 3 | 0.4–0.6 |
| Figuren-Persona | 32 | 2e-4 | 2 | 0.85–1.0 |

VRAM-Matrix (Mistral-Small-3.2-24B QLoRA):

| VRAM | `batch` | `accum` | `seq_len` | `r` |
|---|---|---|---|---|
| 16 GB | 1 | 16 | 2048 | 16 |
| **20 GB** | **1** | **16** | **4096** | **32** |
| 24 GB | 1 | 16 | 4096 | 32 |
| 40+ GB | 2 | 8 | 8192 | 64 |

## 5. Qualitäts-Check

System-Prompt **identisch zum Training** setzen:

```
Du bist die Stimme des Autors von «‹Buchtitel›» und antwortest einer Leserin
im Gespräch. Antworte knapp, präzise und im Geist des Buchs.
```

Tests:

1. Weltfakten: „Wer ist {Hauptfigur}?"
2. Relation: „Wie steht {A} zu {B}?"
3. Szenen-Recall: „Was passiert in Kapitel «X»?"
4. Stil-Fortsetzung aus Kapitel-Anfang.
5. Neues Kapitel mit zwei Figuren generieren.
6. Reverse-Lookup: „Auf welcher Seite steht: ‹Satz›?"

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| OOM | `seq_len=2048`, `batch=1`, `accum=16` |
| Eval-Loss steigt früh | LR halbieren (2e-4 → 1e-4) |
| Repetitive Inferenz | `repetition_penalty=1.05–1.15` |
| Figuren halluziniert | mehr `authorChat`-Samples, +1 Epoche |
| Klingt wie Standard-Mistral | `r` ↑ (32 → 48), +1 Epoche |
| Kopiert Buch wörtlich | Epochen ↓, `lora_dropout=0.05` |
| Antwortet auf Englisch | System-Prompt im Modelfile setzen |
| Satz mitten abgeschnitten | Export mit `max_seq_tokens=4096` neu |

## 7. Links

- [Unsloth-Docs](https://docs.unsloth.ai)
- [Mistral-Small-3.2-Modellkarte](https://huggingface.co/mistralai/Mistral-Small-3.2-24B-Instruct-2506)
- [Unsloth-Variante](https://huggingface.co/unsloth/Mistral-Small-3.2-24B-Instruct-2506-unsloth-bnb-4bit)
- [TRL SFTTrainer](https://huggingface.co/docs/trl/sft_trainer)
