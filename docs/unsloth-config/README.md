# Unsloth-Training-Config

Fertige Scripts, um **Mistral-Small-3.2-24B-Instruct-2506** auf den JSONL-
Exports der Fine-Tuning-Export-Karte zu trainieren. Optimiert für **1× RTX
4000 Ada (20 GB VRAM)**.

> **Modell-Update (April 2026):** Default ist jetzt
> `unsloth/Mistral-Small-3.2-24B-Instruct-2506-unsloth-bnb-4bit` (Mistral-
> Small 3.2, 128k Context, Tekken-V7-Tokenizer, Pixtral-Vision-Encoder).
> Vorgänger Ministral-3-8B-Instruct-2512 produzierte unbrauchbare deutsche
> Fortsetzungen — zu wenig Kapazität für Roman-Domäne. 24B löst das, kostet
> dafür ~3× Trainingszeit und engeres VRAM-Budget (`batch_size=1`).

Zwei Wege, je nach dem wie du arbeitest:

- **Unsloth Studio** (UI, kein Python-Setup nötig) — siehe [„Unsloth Studio"](#unsloth-studio-ui-route) weiter unten. Die Defaults der Export-Karte sind bereits darauf abgestimmt.
- **Unsloth-CLI** (das `train_book.py`-Script hier) — volle Kontrolle, scriptbar, mergen und GGUF-Export automatisiert.

## Inhalt

| Datei | Zweck |
|---|---|
| [`studio-config.yaml`](studio-config.yaml) | Deklarative Config für Studio-Import (Axolotl-Format) — oder als Checkliste für die GUI |
| [`train_book.py`](train_book.py) | CLI-Script: Training + Merge + GGUF-Export in einem |
| [`requirements.txt`](requirements.txt) | Gepinnte Paket-Versionen (nur für CLI-Pfad) |
| [`Modelfile.example`](Modelfile.example) | Ollama-Modelfile für das fertige Modell |

## Setup (einmalig)

```bash
# Conda-Env
conda create -n unsloth python=3.11 -y
conda activate unsloth

# Abhängigkeiten
pip install -r requirements.txt
```

Voraussetzungen: CUDA 12.1+, PyTorch erkennt die GPU (`python -c "import torch; print(torch.cuda.is_available())"` → `True`).

## Daten bereitstellen

Export aus der bookstack-lektorat-UI (Kachel „Fine-Tuning-Export") mit:
- Alle fünf Typen aktiv
- `Max. Token pro Sample = 4096`
- `Vorgerendertes text-Feld = aus` — Studio und das Script rendern das Chat-
  Template selbst über den Tokenizer; ein zweites vorgerendertes Feld würde
  nur kollidieren.

Die Defaults in der Export-Karte erzeugen genau diesen Output — nichts
anzupassen nötig.

`train.jsonl` und `val.jsonl` in **diesen Ordner** legen (oder in Studio
hochladen, siehe unten).

## Unsloth Studio (UI-Route)

Wenn du Studio statt der Kommandozeile nutzt — der Export ist bereits
kompatibel. Zwei Wege in Studio:

### Variante A: Config-Datei importieren (schnellster Weg)

Laut [Unsloth-Studio-Doku](https://unsloth.ai/docs/new/studio) unterstützt
Studio explizit YAML-Import: *„Import a YAML config and Studio will pre-fill
the relevant settings."*

**Wichtig:** Die Studio-YAML enthält **nur `training:` und `lora:`** —
Modell und Dataset werden weiter in der GUI gewählt. Der Import pre-fillt
nur die Hyperparameter.

**Schema-Kuriosität:** Studio benutzt eigene Key-Namen, nicht die von
HuggingFace TrainingArguments. Kritische Unterschiede:

| HF-/Axolotl-Name | Studio-Name |
|---|---|
| `train_on_responses_only` | `train_on_completions` |
| `warmup_ratio` | `warmup_steps` (absolut!) |
| `num_train_epochs` | `num_epochs` |
| `per_device_train_batch_size` | `batch_size` |
| `seed` | `random_seed` |
| `lora.r` | `lora.lora_r` |

Unsere [`studio-config.yaml`](studio-config.yaml) nutzt bereits die
Studio-Namen. Drittanbieter-YAMLs vor dem Upload auf diese Keys prüfen —
falsche Keys werden **stumm ignoriert** (kein Fehler, aber Hyperparameter
bleiben auf Default).

Ablauf:

1. **Studio starten** (einmalig, ausserhalb Conda):
   ```bash
   pip install unsloth
   unsloth studio -H 0.0.0.0 -p 8888
   ```
   Dann `http://localhost:8888` öffnen.
2. **Modell** im „Model"-Tab wählen:
   `unsloth/Mistral-Small-3.2-24B-Instruct-2506-unsloth-bnb-4bit` mit
   Method = **QLoRA**.
3. **Dataset** im „Dataset"-Tab hochladen: `train.jsonl` + `val.jsonl`,
   Format **conversational / messages**. Studio erkennt das `messages`-Feld
   automatisch.
4. Im „Training & Config"-Tab → **Import YAML** →
   [`studio-config.yaml`](studio-config.yaml) hochladen. Hyperparameter
   werden befüllt.
5. Kurz überprüfen, dass `train_on_completions: true` aus der YAML
   tatsächlich übernommen wurde (Toggle sichtbar im Parameters-Panel).
   Fehlt der Toggle in der GUI → Studio-Version zu alt, auf neuere updaten
   oder CLI-Script nutzen. Ohne Completions-Masking verwässert der Buch-
   Stil messbar.
6. **Training starten.** Studio zeigt `train/loss` und `eval/loss` live.
   Erwartung: eval_loss fällt in den ersten ~500 Steps auf ~1.4–1.8, dann
   stabilisiert es sich.
7. **Export:** nach dem Run → „Save / Export" → GGUF Q5_K_M.
   Runterladen, zu Ollama verfrachten (siehe
   [„In Ollama einbinden"](#in-ollama-einbinden)).

### Variante B: Fallback — alles manuell in der GUI

Falls Studio den YAML-Import aus irgendeinem Grund nicht annimmt (alte
Version, Parsing-Fehler), alle Werte klickst du in diese drei Spalten:
**Dataset** (links) · **Parameters** (Mitte) · **Training** (rechts).

#### Dataset-Spalte (links)

- **Choose dataset** → `Local` (falls Datei bereits in Studio) oder
  **Upload** → `train.jsonl` aus dem Export. Format wird als
  Conversational/`messages` automatisch erkannt.
- **Eval dataset → Upload eval file** → `val.jsonl`. Separater Upload,
  nicht im selben Dropdown. Ohne Eval-Datei würde Studio sonst einen Split
  selbst bilden — unsere Export-Karte liefert aber bereits einen sauberen
  Split, deshalb explizit hochladen.
- **Advanced** → Basemodell:
  `unsloth/Mistral-Small-3.2-24B-Instruct-2506-unsloth-bnb-4bit`,
  Method = **QLoRA**.

#### Parameters-Spalte (Mitte)

Oberer Block:

| GUI-Feld | Wert | Grund |
|---|---|---|
| **Max Steps / Use Epochs** | Toggle auf **Use Epochs**, dann **2** | 2 volle Durchläufe für Welt-Internalisierung; Max Steps = 30 ist nur Studio-Smoke-Test-Default |
| **Context Length** | **4096** (Dropdown) | matcht Export-Filter |
| **Learning Rate** | **0.0002** | LoRA-Standard |

**LoRA Settings** (Panel aufklappen, Modus-Button **Enable LoRA** aktiv —
nicht RS-LoRA, nicht LoftQ):

| GUI-Feld | Wert | Grund |
|---|---|---|
| **Rank** | **32** | Default 16 zu klein für Welt + Stil |
| **Alpha** | **32** | alpha = rank (Unsloth-Empfehlung) |
| **Dropout** | **0.00** | Unsloth-patched: 0 am schnellsten |
| **Target Modules** | alle sieben aktiv: `q_proj`, `k_proj`, `v_proj`, `o_proj`, `gate_proj`, `up_proj`, `down_proj` | full-MLP-LoRA; Studio-Default passt |

**Training Hyperparameters → Tab Optimization**:

| GUI-Feld | Wert | Grund |
|---|---|---|
| **Optimizer** | **AdamW 8-bit** | halbiert Optimizer-VRAM |
| **LR scheduler** | **Cosine** (Default Linear überschreiben) | stabiler Ausklang |
| **Batch Size** | **1** | 24B-Modell sprengt mit 2 das 20-GB-Limit |
| **Grad Accum** | **16** (Default 4 erhöhen) | effektive Batch = 16 |
| **Weight Decay** | **0.001** | Studio-Default passt |

**Tab Schedule**:

- **Warmup Ratio** → **0.03** (alternativ Warmup Steps ≈ 3 % der
  Gesamt-Steps).
- Falls hier nochmal Scheduler-Auswahl: **Cosine** sicherstellen.

**Tab Memory**:

- **Precision / bf16** → **bf16** (Ada Lovelace native Unterstützung).
- **Gradient Checkpointing** → **an** (Unsloth-Modus falls wählbar,
  spart VRAM).
- **Sample Packing** → **aus**. Packing würde unabhängige Fortsetzungen
  mischen.

**Train on Completions** — wichtigster Qualitäts-Hebel. Studio-Toggle
heisst genau so (entspricht HF-seitigem `train_on_responses_only`).
Findest du ihn im Parameters-Panel, aktivieren. Chat-Template-Marker
leitet Studio intern aus dem Modell ab — für Mistral-Small-3.2 sind das
`[INST]`/`[/INST]` (Tekken-V7), kein manueller Eintrag nötig.

Fehlt der Toggle → Studio-Version zu alt: update, Config-Upload
(Variante A) mit `train_on_completions: true` erzwingen, oder auf
CLI-Script ausweichen.

**Mistral-Small-3.2-spezifisch — Layer-Auswahl unter Advanced:**

- **`Finetune vision layers`** → **aus**. Mistral-Small-3.2 hat einen
  Pixtral-Vision-Encoder; bei reinem Text-Finetuning würde der sonst
  ohne Bilddaten trainiert (VRAM-Waste + Vision-Gewichte-Korruption).
- **`Finetune language layers`** → **an** (Studio-Default).
- **`Finetune attention modules`** → **an**.
- **`Finetune MLP modules`** → **an**.

#### Training-Spalte (rechts)

- **Training Config → Save** vor dem Start (macht Lauf reproduzierbar).
- **Start Training** klicken. Live-Loss-Chart erscheint oben rechts.
  Erwartung: `eval_loss` fällt in ersten ~500 Steps auf **1.4–1.8**,
  stabilisiert danach.
- Nach Run: Studio-**Export → GGUF Q5_K_M**. Runterladen, zu Ollama
  verfrachten (siehe [„In Ollama einbinden"](#in-ollama-einbinden)).

Das [`train_book.py`](train_book.py) in diesem Ordner ist die CLI-Version
derselben Config — nützlich zum lokalen Testen, wenn Studio nicht
erreichbar ist.

## Run: Single-GPU-CLI (primäre Route)

```bash
cd docs/unsloth-config
CUDA_VISIBLE_DEVICES=0 python train_book.py
```

Während das auf GPU 0 läuft, bleibt GPU 1 frei — ideal für paralleles Ollama
(`CUDA_VISIBLE_DEVICES=1 ollama serve`) oder manuelle Prüfungen.

### Laufzeit (Richtwert)

Bei ~30 000 Trainings-Samples, seq_len 4096, 2 Epochen auf RTX 4000 Ada:
**ca. 18–28 Stunden** (24B ist ~3× langsamer pro Step als 8B). Ada Lovelace
ist ~30 % schneller pro Step als Ampere gleicher VRAM-Klasse, aber für 24B
solltest du Multi-Day-Runs einplanen — oder den Datensatz halbieren.

### Monitoring

```bash
# In einem zweiten Terminal
tensorboard --logdir runs/mistral-small32-buch
```

Wichtige Kurve: **`eval/loss`**. Erwartung:
- Start-Value typischerweise 1.8–2.4 bei Mistral-Small-3.2 (niedriger als
  Ministral-3-8B — Modell startet sprachlich schon kompetenter).
- Fällt über die ersten 500–1500 Steps auf 1.1–1.5.
- Stabilisiert danach. **Steigt eval/loss wieder: Early-Stopping schlägt zu
  (Callback ist aktiv, stoppt nach 3 Eval-Plateaus).**

### Ausgabe

Am Ende des Runs existieren:

```
runs/mistral-small32-buch/
├── checkpoint-XXXX/          # Zwischenstände (max. 3 durch save_total_limit)
├── adapter/                  # LoRA-Adapter (~400 MB)
├── merged/                   # bf16 vollständiges Modell (~48 GB)
└── gguf/
    └── unsloth.Q4_K_M.gguf   # Für Ollama/llama.cpp (~14 GB)
```

## In Ollama einbinden

```bash
cd runs/mistral-small32-buch/gguf
# Modelfile.example ggf. editieren (BOOK_TITLE im SYSTEM-Feld)
ollama create buch-autor -f ../../../Modelfile.example

# Test
ollama run buch-autor "Schreibe den Anfang eines neuen Kapitels."
```

Danach in der bookstack-lektorat-`.env`:

```
API_PROVIDER=ollama
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=buch-autor
OLLAMA_TEMPERATURE=0.8
```

Server neu starten — ab jetzt laufen alle KI-Calls (Lektorat, Chat, Review)
durch dein fine-getunetes Modell.

## Run: Multi-GPU DDP (optional, unofficial)

Unsloth-Open-Source unterstützt Multi-GPU nicht offiziell. Praktisch
funktioniert DDP auf zwei gleichen Karten dennoch — bring aber
`gradient_accumulation_steps` von 16 auf 8 runter, damit die effektive
Batch-Size identisch bleibt (2 GPUs × 1 batch × 8 accum = 16).

```bash
# train_book.py so lassen, nur `gradient_accumulation_steps = 4` setzen
accelerate launch \
    --num_processes 2 \
    --num_machines 1 \
    --mixed_precision bf16 \
    train_book.py
```

**Speed-Up**: ~1.7× (PCIe-Gradient-Sync frisst ~15 % pro Step). Nur sinnvoll,
wenn die Trainingszeit sonst unerträglich lange würde — für einen typischen
Datensatz bleibt die Single-GPU-Route einfacher und stabiler.

## Troubleshooting

### `OSError: CUDA out of memory`

Bei 24B auf 20 GB ist das Profil von Anfang an eng. Optionen in Reihenfolge:

1. **`max_seq_length = 2048`** im Script (Default ist 4096). Halbiert
   Activation-VRAM ohne nennenswerten Quality-Loss — p95 unserer Samples
   liegt bei ~1500 Tokens.
2. **Export neu machen mit `max_seq_tokens=2048`** — filtert lange Samples
   raus. Das Badge „{n} über Limit verworfen" zeigt dir, wie viele.
3. **LoRA-Rang reduzieren**: `r=16, alpha=16` (statt 32/32). Spart ~500 MB
   VRAM bei minimalem Quality-Hit.

### `RuntimeError: [INST] not found in tokens` bei `train_on_responses_only`

Chat-Template hat sich geändert oder passt nicht zum Modell. Check:

```python
print(tokenizer.apply_chat_template(
    [{"role": "user", "content": "test"}],
    tokenize=False,
))
```

Sollte `<s>[INST] test [/INST]` enthalten. Wenn nicht: Modell ist nicht
Mistral-Family — dann `instruction_part`/`response_part` in `train_book.py`
an das tatsächliche Template anpassen.

### `ModuleNotFoundError: triton`

```bash
pip install triton==3.0.0
```

### GGUF-Export schlägt fehl / dauert ewig

`save_pretrained_gguf` baut beim ersten Lauf `llama.cpp` aus dem Source.
Dauert ~5 Minuten, braucht `cmake` und `g++`. Wenn das unerwünscht ist:
Die `save_pretrained_gguf`-Zeile im Script auskommentieren und GGUF später
manuell über `convert_hf_to_gguf.py` aus llama.cpp erzeugen.

### Eval-Loss fällt nicht

- Learning-Rate halbieren (`2e-4` → `1e-4`).
- `r` erhöhen (32 → 48 oder 64) — gibt dem Adapter mehr Kapazität.
- Prüfen, ob `train_on_responses_only` aktiv ist (wichtigster Faktor).

### Modell klingt nach Training wie vorher

- `num_train_epochs` auf 3 erhöhen.
- Sicherstellen, dass der Datensatz ausreichend gross ist (< 5000 Samples
  → Effekt kaum messbar; Komplettanalyse + alle fünf Export-Typen aktivieren).
- Export mit allen Extraktions-Quellen neu machen (Komplettanalyse vorher
  gelaufen?).

## Aufräumen

```bash
# Checkpoints (gross) behalten nur wenn du erneut merchen willst
rm -rf runs/mistral-small32-buch/checkpoint-*

# bf16-Merge ist nur für HuggingFace-Inferenz nötig; bei reinem Ollama-Einsatz
# reicht der adapter/ und die gguf/-Datei
rm -rf runs/mistral-small32-buch/merged
```
