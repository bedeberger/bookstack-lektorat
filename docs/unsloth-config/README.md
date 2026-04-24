# Unsloth-Training-Config

Fertige Scripts, um Ministral-8B auf den JSONL-Exports der Fine-Tuning-Export-
Karte zu trainieren. Optimiert für **1× RTX 4000 Ada (20 GB VRAM)**.

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

**Wichtig:** Die Studio-YAML enthält **nur `training:`, `lora:`, `logging:`** —
Modell und Dataset werden weiter in der GUI gewählt. Der Import pre-fillt
also nur die Hyperparameter.

Ablauf:

1. **Studio starten** (einmalig, ausserhalb Conda):
   ```bash
   pip install unsloth
   unsloth studio -H 0.0.0.0 -p 8888
   ```
   Dann `http://localhost:8888` öffnen.
2. **Modell** im „Model"-Tab wählen: `unsloth/Ministral-8B-Instruct-2410-bnb-4bit`
   mit Method = **QLoRA**.
3. **Dataset** im „Dataset"-Tab hochladen: `train.jsonl` + `val.jsonl`,
   Format **conversational / messages**. Studio erkennt das `messages`-Feld
   automatisch.
4. Im „Training & Config"-Tab → **Import YAML** →
   [`studio-config.yaml`](studio-config.yaml) hochladen. Hyperparameter
   werden befüllt.
5. Kurz überprüfen, dass `train_on_responses_only: true` aus der YAML
   tatsächlich übernommen wurde (Studio-Versionen, die diesen Key noch nicht
   kennen, ignorieren ihn — dann manuell unter „Advanced / Loss masking"
   aktivieren mit `instruction_part = "[INST]"`, `response_part = "[/INST]"`).
6. **Training starten.** Studio zeigt `train/loss` und `eval/loss` live.
   Erwartung: eval_loss fällt in den ersten ~500 Steps auf ~1.4–1.8, dann
   stabilisiert es sich.
7. **Export:** nach dem Run → „Save / Export" → GGUF Q5_K_M.
   Runterladen, zu Ollama verfrachten (siehe
   [„In Ollama einbinden"](#in-ollama-einbinden)).

### Variante B: Fallback — alles manuell in der GUI

Falls Studio den YAML-Import aus irgendeinem Grund nicht annimmt (alte
Version, Parsing-Fehler), nimm die YAML als Checkliste und klick die Werte
von Hand in die entsprechenden Felder. Zentrale Werte:

| GUI-Feld | Wert | Grund |
|---|---|---|
| `max_seq_length` | **4096** | matcht unseren Export-Filter |
| `per_device_train_batch_size` | **2** | füllt 20 GB VRAM gut aus |
| `gradient_accumulation_steps` | **8** | effektive Batch = 16 |
| `num_train_epochs` | **2** | Welt-Internalisierung braucht 2 Durchläufe |
| `learning_rate` | **2e-4** | LoRA-Standard |
| `lr_scheduler_type` | **cosine** | stabiler als linear |
| `warmup_ratio` | **0.03** | wenig Warmup nötig |
| `lora.r` | **32** | Sweet-Spot für Welt + Stil |
| `lora.lora_alpha` | **32** | alpha = r (Unsloth-Empfehlung) |
| `lora.lora_dropout` | **0** | Unsloth-patched: 0 ist am schnellsten |
| `optim` | **adamw_8bit** | halbiert Optimizer-VRAM |
| `bf16` | **true** | Ada Lovelace unterstützt bf16 nativ |
| `packing` | **false** | erhält Sample-Grenzen |
| `train_on_responses_only` | **true** | Kernfeature: Loss nur auf Assistant |
| `instruction_part` | **`[INST]`** | Ministral-Template-Marker |
| `response_part` | **`[/INST]`** | Ministral-Template-Marker |

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
**ca. 6–9 Stunden**. Ada Lovelace ist ~30 % schneller pro Step als Ampere
gleicher VRAM-Klasse, daher gut genug für Overnight-Runs.

### Monitoring

```bash
# In einem zweiten Terminal
tensorboard --logdir runs/ministral-buch
```

Wichtige Kurve: **`eval/loss`**. Erwartung:
- Start-Value typischerweise 2.2–2.8 bei Ministral.
- Fällt über die ersten 500–1500 Steps auf 1.4–1.8.
- Stabilisiert danach. **Steigt eval/loss wieder: Early-Stopping schlägt zu
  (Callback ist aktiv, stoppt nach 3 Eval-Plateaus).**

### Ausgabe

Am Ende des Runs existieren:

```
runs/ministral-buch/
├── checkpoint-XXXX/          # Zwischenstände (max. 3 durch save_total_limit)
├── adapter/                  # LoRA-Adapter (~200 MB)
├── merged/                   # bf16 vollständiges Modell (~16 GB)
└── gguf/
    └── unsloth.Q5_K_M.gguf   # Für Ollama/llama.cpp (~5.5 GB)
```

## In Ollama einbinden

```bash
cd runs/ministral-buch/gguf
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
`gradient_accumulation_steps` von 8 auf 4 runter, damit die effektive
Batch-Size identisch bleibt (2 GPUs × 2 batch × 4 accum = 16).

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

Dein Export hat mehr Samples mit extremen Längen als erwartet. Optionen:

1. **Export neu machen mit `max_seq_tokens=4096`** — filtert alle zu langen
   Samples raus (empfohlen). Das Badge „{n} über Limit verworfen" zeigt dir,
   wie viele.
2. **`max_seq_length = 2048`** im Script, dafür `per_device_batch_size = 1`
   und `gradient_accumulation_steps = 16`.

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
rm -rf runs/ministral-buch/checkpoint-*

# bf16-Merge ist nur für HuggingFace-Inferenz nötig; bei reinem Ollama-Einsatz
# reicht der adapter/ und die gguf/-Datei
rm -rf runs/ministral-buch/merged
```
