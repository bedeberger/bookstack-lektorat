# Fine-Tuning auf den Exportdaten

End-to-End: von den JSONL-Exports der Fine-Tuning-Export-Karte zu einem lokal
laufenden Modell, das Stil, Welt und Figuren deines Buchs internalisiert hat.

**Primärer Pfad:** [Unsloth](https://github.com/unslothai/unsloth) + QLoRA.
Open-Source, 2× schneller als der HuggingFace-Standard, läuft auf Consumer-GPUs.
Zwei Varianten:

- **[Unsloth Studio](https://studio.unsloth.ai)** — Web-UI, kein Python-Setup.
  JSONL hochladen, Basemodell wählen, trainieren. Die Defaults der Export-
  Karte sind exakt für diese Route abgestimmt. Schritt-für-Schritt-Anleitung
  mit Parameter-Tabelle in [docs/unsloth-config/README.md](unsloth-config/README.md#unsloth-studio-ui-route).
- **Unsloth-CLI** — Python-Script für volle Kontrolle, scriptbar, Merge und
  GGUF-Export automatisiert. Fertiges Script in
  [docs/unsloth-config/train_book.py](unsloth-config/train_book.py).

Eine zweite Route über [`mistral-finetune`](https://github.com/mistralai/mistral-finetune)
ist weiter unten dokumentiert — nur sinnvoll, wenn du mindestens 40 GB VRAM und
einen Grund für vollen bf16-LoRA statt QLoRA hast. Sonst: Unsloth nehmen.

---

## 1. Modell- und Hardware-Entscheidung

### Das Basemodell

**`unsloth/Ministral-3-8B-Instruct-2512-unsloth-bnb-4bit`** — Dez-2025-Release
von Mistrals Ministral 3, Unsloth-vorquantisiert als Dynamic-4-bit. Gründe:

- **Neueste Generation (Dez 2025)** — direktes Upgrade zum 8B-2410. Bessere
  Multilingual-Performance, stärkere Instruct-Adhärenz (Arena Hard 0.551
  laut Unsloth-Model-Card).
- **Native DE-Kompetenz** aus Mistrals EU-multilingualem Training. Für
  literarische deutsche Prosa stärker als Llama-3.1-8B oder Qwen2.5-7B.
- **256 k Context** (verdoppelt gegenüber 2410) — Buch-Chat und
  Komplettanalyse im Tool können längere Dokumente ohne Split verarbeiten.
- **8 B Parameter** — trainieren UND deployen auf einer Consumer-Karte:
  QLoRA-Training ~12 GB VRAM, Inferenz nach Q5_K_M-Merge ~6 GB.
- **`[INST]`/`[/INST]`-Template** unverändert (via Mistral-Common-Tokenizer
  gerendert) — Exporter und Prompt-Konventionen im Projekt passen weiter.
- **Unsloth-Dynamic-4bit** statt Plain-bnb-4bit → bessere Quantisierungs-
  Qualität bei identischem VRAM.
- **Ollama-tauglich** über `save_pretrained_gguf` aus Unsloth, Ergebnis
  als `OLLAMA_MODEL` direkt in bookstack-lektorat einsetzbar.

Ausgeschlossen:

| Modell | Grund |
|---|---|
| Ministral-3-3B | Zu klein für Welt + Stil in einem Modell — verliert schneller die Persona. |
| Ministral-3-14B | 14 B QLoRA passt, aber 1.5–1.7× längere Trainingszeit; nur bei grösseren Büchern lohnend. |
| Ministral-3-8B-Reasoning | Reasoning-Variante ist auf CoT optimiert, würde Buch-Stil verwässern. |
| Ministral-8B-2410 | Vorgänger, noch kompatibel, aber strikt schlechter als 2512. |
| Mistral-Small-3.2-24B | QLoRA-4bit auf 20 GB knapp machbar (~16 GB), aber ~2.5× Trainingszeit und KV-Cache sprengt zweite Karte. |
| Llama-3.3-8B | Anderes Chat-Template, DE schwächer auf Prosa. |
| Qwen3-8B | Stark, aber DE leicht unter Ministral auf literarischem Text. |

### Deine Umgebung: 2× RTX 4000 Ada (20 GB / 20 GB)

**Primäre Route: Single-GPU-Training auf einer Karte, zweite Karte für
Evaluation/Inferenz parallel.** Unsloth-Open-Source ist Single-GPU-fokussiert;
QLoRA für Ministral-3-8B braucht nur ~12 GB, d. h. eine 4000 Ada genügt locker.

Training-Budget für diese Karte:

- `max_seq_length = 4096`
- `per_device_train_batch_size = 2`
- `gradient_accumulation_steps = 8` → effektive Batch-Size = 16
- **~14–16 GB VRAM-Peak**, Rest als Sicherheit

Die zweite Karte (`CUDA_VISIBLE_DEVICES=1` für Inferenz) kann während des
Trainings Zwischen-Checkpoints evaluieren, ohne die Trainings-GPU zu bremsen.

Alternative, unofficial: **Multi-GPU DDP** über `accelerate launch
--num_processes=2`. Unsloth deklariert Multi-GPU in der Open-Source-Version
nicht offiziell, in der Praxis funktioniert DDP aber. Effekt: ~1.7× Speed-up
(Gradient-Sync-Overhead auf PCIe). Siehe
[docs/unsloth-config/README.md](unsloth-config/README.md) für den Befehl.
Defaultempfehlung bleibt Single-GPU — einfacher, stabiler, weniger Kleinkram.

---

## 2. Daten vorbereiten

### 2.1 Export aus dem Tool

1. UI → Buch wählen → Kachel **„Fine-Tuning-Export"**.
2. Alle fünf Typen aktiv: `Stil`, `Szene`, `Dialog`, `Autor-Chat`, `Korrekturen`.
3. `Min. Zeichen = 200`, `Max. Zeichen = 4000`.
4. `Validation-Split = 0.05` (bei > 20 000 Samples), sonst `0.1`.
5. **Unsloth-Optionen**:
   - `Max. Token pro Sample = 4096` → filtert Samples raus, die beim
     Training zu stiller Truncation führen würden.
   - `Vorgerendertes text-Feld` = optional **an**, wenn du das Mistral-Template
     direkt im JSONL haben willst (dann ist `formatting_func` im Script
     überflüssig).
6. **Generieren**, warten, Stats prüfen, `train.jsonl` und `val.jsonl` laden.

Nach dem Export zeigt die Karte zusätzlich zu den Zähl-Badges:

- **p95 / max Token** — die tatsächliche Längenverteilung nach Tokenisierung.
- **empfohlen seq_len** — die nächste Zweierpotenz über p95 + 10 % Puffer.
- **{n} über Limit verworfen** — nur wenn der Seq-Filter gegriffen hat.

Orientiere deinen `max_seq_length`-Wert im Training an dem empfohlenen Wert.

### 2.2 Format

Jede Zeile ist ein kompletter Chat:

```json
{"messages":[
  {"role":"system","content":"Du bist die Stimme des Autors von «…» …"},
  {"role":"user","content":"Wer ist Hans Meier?"},
  {"role":"assistant","content":"Hans Meier ist der Protagonist …"}
]}
```

Mit `emit_text=true` zusätzlich ein `text`-Feld mit dem vollen Mistral-Chat-
Template als String. Beide Felder sind kompatibel — Unsloth/TRL nimmt wahlweise
`messages` (via `formatting_func`) oder `text` (via `dataset_text_field`).

### 2.3 Schnell validieren

```bash
wc -l train.jsonl val.jsonl
python3 -c "import json; [json.loads(l) for l in open('train.jsonl')]; print('OK')"
```

---

## 3. Primärer Pfad: Unsloth

Die komplette, lauffähige Konfiguration liegt unter
[docs/unsloth-config/](unsloth-config/):

| Datei | Inhalt |
|---|---|
| [`train_book.py`](unsloth-config/train_book.py) | Single-GPU-Script, 20-GB-optimiert, `train_on_responses_only`, Merge + GGUF-Export |
| [`requirements.txt`](unsloth-config/requirements.txt) | Feste Versionen, die zusammen funktionieren |
| [`Modelfile.example`](unsloth-config/Modelfile.example) | Ollama-Modelfile für das fertige Modell |
| [`README.md`](unsloth-config/README.md) | Setup, Run-Kommandos, Troubleshooting, Multi-GPU-Variante |

Kurzfassung des Flows:

```bash
# 1. Conda-Env + Unsloth
conda create -n unsloth python=3.11 -y
conda activate unsloth
pip install -r docs/unsloth-config/requirements.txt

# 2. Export-JSONLs in den Config-Ordner
cp ~/Downloads/train.jsonl docs/unsloth-config/
cp ~/Downloads/val.jsonl   docs/unsloth-config/

# 3. Single-GPU-Training (nutzt GPU 0, zweite bleibt frei)
cd docs/unsloth-config
CUDA_VISIBLE_DEVICES=0 python train_book.py

# 4. Merge zu GGUF (wird am Ende des Scripts automatisch gemacht)
#    Output: runs/ministral3-buch/gguf/*.gguf

# 5. In Ollama einbinden
cd runs/ministral3-buch/gguf
ollama create buch-autor -f ../../../Modelfile.example
ollama run buch-autor "Schreibe den Anfang eines neuen Kapitels."
```

### Die drei nicht-offensichtlichen Entscheidungen im Script

1. **`train_on_responses_only`** — Loss nur auf Assistant-Tokens. Ohne das
   lernt das Modell auch aus unseren System-Prompts und User-Fragen; der
   Stil-Effekt aus dem `style`-Block verwässert messbar.
2. **`max_seq_length = 4096`** statt 8192 — p95 unserer Samples liegt bei
   ≈ 1500 Tokens. 8192 kostet doppelt VRAM für null Quality-Gain.
3. **`packing = False`** — unsere `pageCont`/`chapTrans`/`scnTrans`-Samples
   sind inhaltlich an Grenzen gebunden. Packing würde zwei unabhängige
   Fortsetzungen in eine Sequenz mischen und die Boundary-Semantik brechen.

### Hyperparameter-Matrix nach Ziel

| Ziel | `r` | `lr` | Epochen | Temp. (Inferenz) |
|---|---|---|---|---|
| Stilimitation (leicht) | 16 | 2 e-4 | 1–2 | 0.7–0.8 |
| **Welt internalisieren** (Default) | **32** | **2 e-4** | **2** | **0.7–0.85** |
| Exakte Faktenwiedergabe | 64 | 1 e-4 | 3 | 0.4–0.6 |
| Figuren-Chat / Persona | 32 | 2 e-4 | 2 | 0.85–1.0 |

Defaults in [`train_book.py`](unsloth-config/train_book.py) entsprechen dem
Welt-internalisieren-Ziel.

### VRAM-Matrix (falls du woanders trainierst)

| VRAM | `batch` | `accum` | `seq_len` | `r` |
|---|---|---|---|---|
| 12 GB (3060/4070) | 1 | 16 | 2048 | 16 |
| 16 GB (4060 Ti 16G) | 1 | 16 | 4096 | 32 |
| **20 GB (RTX 4000 Ada)** | **2** | **8** | **4096** | **32** |
| 24 GB (3090/4090) | 2 | 8 | 4096 | 32 |
| 40 GB+ (A6000/A100) | 4 | 4 | 8192 | 64 |

---

## 4. Qualitäts-Check nach dem Training

System-Prompt beim Testen **identisch zum Training** setzen:

```
Du bist die Stimme des Autors von «‹Buchtitel›» und antwortest einer Leserin
im Gespräch. Antworte knapp, präzise und im Geist des Buchs.
```

Testfragen:

1. **Weltfakten:** „Wer ist {Hauptfigur}?" → sollte aus `authorChat`-Material
   zitieren, nicht halluzinieren.
2. **Relation:** „Wie steht {A} zu {B}?" → Beziehungsbeschreibung.
3. **Szenen-Recall:** „Was passiert in Kapitel «X»?" → Kapitelzusammenfassung.
4. **Stil-Fortsetzung:** Erster Absatz aus einem zufälligen Kapitel →
   Fortsetzung. Muss wie der Autor klingen, nicht wie Standard-Mistral.
5. **Neues Kapitel dichten:** „Schreibe ein neues Kapitel, in dem {A} und
   {B} sich treffen." → soll Figuren korrekt einsetzen.
6. **Reverse-Lookup:** „Auf welcher Seite steht: ‹exakter Satz›?" → nutzt
   `revPage`-Samples.

Tests 1–4 ok → Welt internalisiert. Test 5 ok → Fortsetzungen klappen.
Test 6 ok → Buchwissen adressierbar.

---

## 5. Troubleshooting

| Symptom | Ursache | Fix |
|---|---|---|
| OOM beim Training | `seq_len`/`batch` zu gross | `seq_len=2048`, `batch=1`, `accum=16` |
| Eval-Loss steigt früh | LR zu hoch | LR halbieren (2 e-4 → 1 e-4) |
| Modell repetitiv bei Inferenz | `repetition_penalty` fehlt | 1.05–1.15 |
| Modell halluziniert Figuren | zu wenig Welt-Q&A | mehr `authorChat`-Paraphrasen, Epoche +1 |
| Modell schreibt wie Standard-Mistral | Training zu kurz | `r` ↑ (32 → 48), Epochen +1 |
| Modell kopiert Buch wörtlich | Overfitting | Epochen ↓, `lora_dropout=0.05` |
| Modell antwortet auf Englisch | System-Prompt fehlt in Inferenz | im Modelfile `SYSTEM "Du bist …"` setzen |
| Assistant-Ende wird mitten im Satz abgeschnitten | Seq-Filter nicht genutzt | Export mit `max_seq_tokens=4096` neu generieren |

---

## 6. Option B: `mistral-finetune` (offiziell, nur bei ≥ 40 GB VRAM)

Mistrals offizielles CLI. Produktionsstabil, macht nur LoRA — **kein** QLoRA,
d. h. Ministral-3-8B braucht ca. 40–48 GB VRAM zum Trainieren. Für dich auf
2× 20 GB relevant nur mit Tensor-Parallelism — deutlich mehr Aufwand als die
Unsloth-Route.

Kurz-Setup:

```bash
git clone https://github.com/mistralai/mistral-finetune.git
cd mistral-finetune
pip install -r requirements.txt

pip install -U "huggingface_hub[cli]"
hf login
hf download mistralai/Ministral-3-8B-Instruct-2512 \
  --local-dir ./models/ministral3-8b \
  --exclude "consolidated.safetensors"

python -m utils.reformat_data /abs/path/train.jsonl
python -m utils.reformat_data /abs/path/val.jsonl
```

`config.yaml`:

```yaml
data:
  instruct_data:      "/abs/path/train.reformatted.jsonl"
  eval_instruct_data: "/abs/path/val.reformatted.jsonl"
  data: ""
model_id_or_path: "/abs/path/models/ministral3-8b"
lora:
  enable: true
  rank: 32
seq_len: 4096
batch_size: 1
max_steps: 3000
optim:
  lr: 1.e-4
  weight_decay: 0.1
  pct_start: 0.05
seed: 0
log_freq: 10
eval_freq: 200
save_frequency: 500
no_eval: false
ckpt_only: false
run_dir: "/abs/path/runs/ministral3-8b-buch"
```

Start (Multi-GPU empfohlen):

```bash
torchrun --nproc-per-node 2 -m train config.yaml
tensorboard --logdir /abs/path/runs/ministral3-8b-buch
```

Inferenz dann über vLLM mit `LoRARequest` — Details in der offiziellen
[mistral-finetune-Doku](https://github.com/mistralai/mistral-finetune).

---

## 7. Weiterführend

- **Unsloth-Docs:** [docs.unsloth.ai](https://docs.unsloth.ai)
- **Ministral-3-Modellkarte:** [huggingface.co/mistralai/Ministral-3-8B-Instruct-2512](https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512)
- **Unsloth-Collection:** [huggingface.co/collections/unsloth/ministral-3](https://huggingface.co/collections/unsloth/ministral-3)
- **TRL SFTTrainer:** [huggingface.co/docs/trl](https://huggingface.co/docs/trl/sft_trainer)
- **mistral-finetune:** [github.com/mistralai/mistral-finetune](https://github.com/mistralai/mistral-finetune)

---

## TL;DR

1. Export aus der UI mit allen fünf Typen + `max_seq_tokens=4096`.
2. `docs/unsloth-config/train_book.py` auf deiner RTX 4000 Ada laufen lassen
   (`CUDA_VISIBLE_DEVICES=0 python train_book.py`).
3. Script merged am Ende zu GGUF; mit `docs/unsloth-config/Modelfile.example`
   in Ollama laden.
4. `.env` → `OLLAMA_MODEL=buch-autor` und dein bookstack-lektorat nutzt
   ab sofort das fine-getunete Modell.
