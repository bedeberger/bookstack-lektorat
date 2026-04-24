# Fine-Tuning eines Ministral-Modells mit den Exportdaten

End-to-End-Anleitung: von den JSONL-Exports der Fine-Tuning-Export-Karte zu einem fertigen LoRA-Adapter, der den Stil, die Welt und die Figuren deines Buchs internalisiert hat.

Zwei Wege werden dokumentiert:
- **Option A:** [`mistral-finetune`](https://github.com/mistralai/mistral-finetune) — offizielles CLI von Mistral, produktionstauglich, braucht eine grosse GPU.
- **Option B:** [Unsloth](https://github.com/unslothai/unsloth) — 2× schneller, läuft Ministral-3B dank 4-bit-QLoRA auf 12-GB-Consumer-GPUs.

Wenn du unsicher bist: **Unsloth** nehmen. Es ist einsteigerfreundlicher und kommt mit weniger Hardware aus.

---

## 1. Daten vorbereiten

### 1.1 Export aus dem Tool

1. In der UI Buch wählen → Kachel **„Fine-Tuning-Export"** öffnen.
2. Alle 5 Typen aktiviert lassen (`Stil`, `Szene`, `Dialog`, `Autor-Chat`, `Korrekturen`).
3. `Min. Zeichen` = 200, `Max. Zeichen` = 4000 (Default) passen für Ministral.
4. `Validation-Split` = 0.05 (5 %) ist genug; 10 % nur wenn du sehr viele Samples hast.
5. **Generieren** klicken, warten, `train.jsonl` und `val.jsonl` herunterladen.
6. Die Dateien sollten je mehrere MB gross sein. Ein aktives 300-Seiten-Buch mit Komplettanalyse kommt grob auf **30 000–50 000 Samples**.

### 1.2 Format

Jede Zeile ist ein kompletter Chat im OpenAI/Mistral-Format:

```json
{"messages":[
  {"role":"system","content":"Du bist die Stimme des Autors von «…» …"},
  {"role":"user","content":"Wer ist Hans Meier?"},
  {"role":"assistant","content":"Hans Meier ist der Protagonist, ein ehemaliger Uhrmacher …"}
]}
```

Drei Rollen, in dieser Reihenfolge. Das ist exakt das Format, das sowohl `mistral-finetune` als auch Unsloth/TRL erwarten.

### 1.3 Schnell validieren

```bash
# Anzahl Zeilen
wc -l train.jsonl val.jsonl

# JSON-Syntax prüfen
python3 -c "import json,sys; [json.loads(l) for l in open('train.jsonl')]; print('OK')"
```

---

## 2. Modellwahl & Hardware

| Basismodell | Parameter | LoRA-Training (bf16) | QLoRA (4-bit) | Inferenz | Eignung |
|---|---|---|---|---|---|
| **Ministral-3B-Instruct** | 3 B | 16–24 GB VRAM | **8–12 GB** | 4–6 GB | Stiltreue gut, Weltwissen mässig |
| **Ministral-8B-Instruct-2410** | 8 B | 40–48 GB VRAM | **16–24 GB** | 10–12 GB | Stiltreue + Weltwissen gut, Empfehlung |
| Mistral-7B-v0.3 (Alternative) | 7 B | 24 GB VRAM | 12–16 GB | 10–12 GB | Grösser verfügbar, weniger „edge-tuned" |
| Mistral-Nemo-Instruct | 12 B | 48 GB+ | 24 GB | 12–16 GB | Stärker, aber langsamer |

Für dein Ziel (Welt internalisieren + Fortsetzungen dichten) ist **Ministral-8B** die richtige Wahl, wenn du mindestens 24 GB VRAM hast (RTX 4090, A6000, A100-40GB). Sonst **Ministral-3B mit QLoRA** auf RTX 3060 12 GB aufwärts.

---

## Option A: `mistral-finetune` (offiziell)

Stabil, produktionsnah, maintained von Mistral. Nur LoRA, kein QLoRA → braucht die volle Modellgrösse im VRAM.

### A.1 Installation

```bash
git clone https://github.com/mistralai/mistral-finetune.git
cd mistral-finetune
pip install -r requirements.txt
```

Funktioniert mit Python 3.10+ und PyTorch 2.2+.

### A.2 Modell herunterladen

HuggingFace-Token mit Mistral-Zugang brauchst du.

```bash
pip install -U "huggingface_hub[cli]"
hf login

# Ministral-8B:
hf download mistralai/Ministral-8B-Instruct-2410 \
  --local-dir ./models/ministral-8b \
  --exclude "consolidated.safetensors"
```

Für die 3B-Variante: `mistralai/Ministral-3B-Instruct-2410` (wenn im HF-Zugriff freigeschaltet; falls nicht, nimm Unsloth, dort gibt es entbundelte Checkpoints).

### A.3 Daten reformatieren

`mistral-finetune` bringt ein Utility, das Duplicates entfernt, Message-Struktur validiert und Token-Statistik druckt:

```bash
python -m utils.reformat_data /abs/path/train.jsonl
python -m utils.reformat_data /abs/path/val.jsonl
```

Das produziert `train.reformatted.jsonl` und `val.reformatted.jsonl` in demselben Verzeichnis.

### A.4 Config-Datei

`config.yaml`:

```yaml
# Datenpfade (absolute Pfade)
data:
  instruct_data: "/abs/path/train.reformatted.jsonl"
  eval_instruct_data: "/abs/path/val.reformatted.jsonl"
  data: ""

# Modell
model_id_or_path: "/abs/path/models/ministral-8b"

# LoRA
lora:
  enable: true
  rank: 32              # höher = mehr Kapazität; 32 ist guter Startwert für Welt-Internalisierung
  # alpha: 64           # default = 2×rank

# Sequenz & Batching
seq_len: 8192           # alle unsere Samples ≤ 4000 Zeichen; 8192 Tokens deckt auch Multi-Absatz-Kontexte
batch_size: 1
# Wenn VRAM knapp: gradient_accumulation_steps erhöhen

# Training-Länge
max_steps: 3000         # siehe Faustregel unten
optim:
  lr: 1.e-4             # 1e-4 bis 2e-4 ist Sweet Spot für LoRA
  weight_decay: 0.1
  pct_start: 0.05       # 5 % warmup

seed: 0
log_freq: 10
eval_freq: 200
save_frequency: 500
no_eval: false
ckpt_only: false

run_dir: "/abs/path/runs/ministral-8b-buch"
wandb:
  key: null             # optional: dein W&B-API-Key für Live-Monitoring
```

**`max_steps`-Faustregel:**

```
max_steps = (samples / batch_size) × epochs / accumulation_steps
```

Bei 30 000 Samples, `batch_size=1`, `accumulation=8`, 2 Epochen: `30000 × 2 / 8 = 7500`. Als Startwert konservativ **2000–4000 Steps** und Early-Stop via Eval-Loss — siehe unten.

### A.5 Training starten

```bash
# Eine GPU
torchrun --nproc-per-node 1 -m train config.yaml

# Mehrere GPUs (z.B. 4)
torchrun --nproc-per-node 4 -m train config.yaml
```

Monitoring:

```bash
tensorboard --logdir /abs/path/runs/ministral-8b-buch
```

Eval-Loss verfolgen: sollte über 500–1500 Steps fallen, dann stabilisieren. **Sobald Eval-Loss wieder steigt → stoppen und letzten Checkpoint vor der Kehre verwenden** (overfitting).

### A.6 Inferenz mit vLLM

```bash
pip install vllm
```

```python
from vllm import LLM, SamplingParams
from vllm.lora.request import LoRARequest

llm = LLM(
    model="./models/ministral-8b",
    enable_lora=True,
    max_lora_rank=32,
)
adapter = LoRARequest(
    lora_name="buch",
    lora_int_id=1,
    lora_path="/abs/path/runs/ministral-8b-buch/checkpoints/checkpoint_003000",
)

messages = [
  {"role": "system", "content": "Du bist die Stimme des Autors von «Mein Buchtitel» und antwortest einer Leserin im Gespräch. Antworte knapp, präzise und im Geist des Buchs."},
  {"role": "user",   "content": "Schreibe den Anfang eines neuen Kapitels, in dem Hans Meier das erste Mal auf Elena trifft."},
]
outputs = llm.chat(
    messages,
    SamplingParams(temperature=0.8, max_tokens=1500, top_p=0.95, repetition_penalty=1.05),
    lora_request=adapter,
)
print(outputs[0].outputs[0].text)
```

---

## Option B: Unsloth (einfacher, 4-bit QLoRA)

Einfachster Weg. Funktioniert mit Ministral-3B **und** Ministral-8B. Auch Consumer-GPUs (RTX 3060 12 GB, 4070 Ti, …) reichen dank QLoRA.

### B.1 Installation

```bash
# Fresh Conda-Env empfohlen, Python 3.11
conda create -n unsloth python=3.11 -y
conda activate unsloth

pip install "unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git"
pip install --no-deps "trl<0.9.0" peft accelerate bitsandbytes
```

### B.2 Training-Script (`train_book.py`)

```python
from unsloth import FastLanguageModel
from datasets import load_dataset
from trl import SFTTrainer
from transformers import TrainingArguments

# ── Modell laden (4-bit) ────────────────────────────────────────────────
MODEL = "mistralai/Ministral-8B-Instruct-2410"   # oder Ministral-3B
MAX_SEQ = 8192

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name=MODEL,
    max_seq_length=MAX_SEQ,
    dtype=None,             # auto: bf16 auf Ampere+
    load_in_4bit=True,
)

# ── LoRA-Adapter anhängen ───────────────────────────────────────────────
model = FastLanguageModel.get_peft_model(
    model,
    r=32,                   # 32 oder 64 für Welt-Internalisierung
    lora_alpha=64,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                    "gate_proj", "up_proj", "down_proj"],
    lora_dropout=0,
    bias="none",
    use_gradient_checkpointing="unsloth",
    random_state=42,
)

# ── Daten & Chat-Template ───────────────────────────────────────────────
def fmt(example):
    return tokenizer.apply_chat_template(
        example["messages"],
        tokenize=False,
        add_generation_prompt=False,
    )

train_ds = load_dataset("json", data_files="train.jsonl", split="train")
eval_ds  = load_dataset("json", data_files="val.jsonl",   split="train")

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=train_ds,
    eval_dataset=eval_ds,
    formatting_func=fmt,
    max_seq_length=MAX_SEQ,
    packing=False,
    args=TrainingArguments(
        output_dir="runs/ministral-buch",
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        num_train_epochs=2,
        warmup_ratio=0.03,
        learning_rate=2e-4,
        bf16=True,
        logging_steps=20,
        eval_strategy="steps",
        eval_steps=200,
        save_strategy="steps",
        save_steps=500,
        save_total_limit=3,
        optim="adamw_8bit",
        weight_decay=0.01,
        lr_scheduler_type="cosine",
        seed=42,
        report_to="tensorboard",
    ),
)

trainer.train()
model.save_pretrained("runs/ministral-buch/adapter")
tokenizer.save_pretrained("runs/ministral-buch/adapter")
```

Starten:

```bash
python train_book.py
tensorboard --logdir runs/ministral-buch
```

### B.3 Inferenz mit Unsloth

```python
from unsloth import FastLanguageModel
from transformers import TextStreamer

model, tokenizer = FastLanguageModel.from_pretrained(
    "runs/ministral-buch/adapter",
    max_seq_length=8192,
    load_in_4bit=True,
)
FastLanguageModel.for_inference(model)

messages = [
  {"role": "system", "content": "Du bist die Stimme des Autors von «Mein Buchtitel»."},
  {"role": "user",   "content": "Schreibe den Anfang eines neuen Kapitels, in dem …"},
]
inputs = tokenizer.apply_chat_template(
    messages, tokenize=True, add_generation_prompt=True, return_tensors="pt"
).to("cuda")

streamer = TextStreamer(tokenizer, skip_prompt=True)
model.generate(
    input_ids=inputs,
    streamer=streamer,
    max_new_tokens=1500,
    temperature=0.8,
    top_p=0.95,
    repetition_penalty=1.05,
    do_sample=True,
)
```

### B.4 Merge (optional)

Wenn du nicht mit Adapter, sondern mit einem „fertigen" Modell arbeiten möchtest (z. B. für Ollama/llama.cpp):

```python
from unsloth import FastLanguageModel
model, tokenizer = FastLanguageModel.from_pretrained("runs/ministral-buch/adapter")
model.save_pretrained_merged("runs/ministral-buch/merged", tokenizer, save_method="merged_16bit")
# Für GGUF (llama.cpp / Ollama):
model.save_pretrained_gguf("runs/ministral-buch/gguf", tokenizer, quantization_method="q4_k_m")
```

Das `gguf`-Ergebnis kannst du in Ollama einbinden:

```bash
cd runs/ministral-buch/gguf
cat > Modelfile <<EOF
FROM ./unsloth.Q4_K_M.gguf
PARAMETER temperature 0.8
PARAMETER repeat_penalty 1.05
SYSTEM "Du bist die Stimme des Autors von «Mein Buchtitel»."
EOF
ollama create buch-autor -f Modelfile
ollama run buch-autor "Schreibe den Anfang eines neuen Kapitels."
```

Danach kannst du dein fine-getuntes Modell direkt im bookstack-lektorat als `OLLAMA_MODEL=buch-autor` einsetzen.

---

## 3. Hyperparameter-Empfehlung je Ziel

| Ziel | `r` (LoRA-Rank) | `lr` | Epochen | Temperature (Inferenz) |
|---|---|---|---|---|
| Stilimitation (leicht) | 8–16 | 2 e-4 | 1–2 | 0.7–0.8 |
| **Welt internalisieren** (dein Ziel) | **32–64** | **1–2 e-4** | **2–3** | **0.7–0.85** |
| Exakte Faktenwiedergabe | 64–128 | 1 e-4 | 3–4 | 0.4–0.6 |
| Figuren-Chat / Persona | 32 | 2 e-4 | 2 | 0.85–1.0 |

## 4. Qualitäts-Check nach dem Training

Nach dem Training diese Testfragen abarbeiten (System-Prompt immer gleich wie im Training):

1. **Weltfakten:** „Wer ist {Hauptfigur}?" → sollte aus der `authorChat`-Antwort zitieren.
2. **Relation:** „Wie steht {A} zu {B}?" → erwartet die Beziehungsbeschreibung.
3. **Szenen-Recall:** „Was passiert in Kapitel «X»?" → Kapitelzusammenfassung.
4. **Stil-Fortsetzung:** Erster Absatz aus einem zufälligen Kapitel → Fortsetzung. Muss wie Autor klingen, nicht wie Standard-Mistral.
5. **Neues Kapitel dichten:** „Schreibe ein neues Kapitel, in dem {A} und {B} sich treffen." → soll Figuren korrekt verwenden, nicht halluzinieren.
6. **Reverse-Lookup:** „Auf welcher Seite steht: ‹exakter Satz›?" → sollte `revPage`-Samples gelernt haben.

Wenn Tests 1–4 funktionieren: das Modell hat die Welt internalisiert. Wenn 5 überzeugt: Fortsetzungen klappen. Wenn 6 funktioniert: Buchwissen ist adressierbar.

## 5. Troubleshooting

| Symptom | Ursache | Fix |
|---|---|---|
| OOM beim Training | `seq_len` / `batch_size` zu gross | `seq_len=4096`, `batch_size=1`, `gradient_accumulation_steps=8` |
| Eval-Loss steigt früh | zu hohe LR | LR halbieren (2 e-4 → 1 e-4) |
| Modell repetitiv bei Inferenz | `repetition_penalty` fehlt | 1.05–1.15 setzen |
| Modell halluziniert Figuren | Zu wenig Welt-Q&A | Mehr `authorChat`-Paraphrasen, zusätzliche Epoche |
| Modell schreibt wie Standard-Mistral | Training unterbrochen / zu kurz | Länger trainieren, `r` erhöhen |
| Modell kopiert Buch wörtlich | Overfitting | Epochen ↓, LR ↓, `lora_dropout=0.05` setzen |
| Ollama-Model generiert Englisch | System-Prompt falsch / fehlt | Im Modelfile `SYSTEM "Du bist …"` setzen |

## 6. Weiterführend

- **mistral-finetune Docs:** [github.com/mistralai/mistral-finetune](https://github.com/mistralai/mistral-finetune)
- **Unsloth Docs:** [docs.unsloth.ai](https://docs.unsloth.ai)
- **Ministral-Modell-Kartee:** [huggingface.co/mistralai/Ministral-8B-Instruct-2410](https://huggingface.co/mistralai/Ministral-8B-Instruct-2410)
- **vLLM LoRA-Inferenz:** [docs.vllm.ai](https://docs.vllm.ai/en/latest/models/lora.html)
- **TRL SFTTrainer:** [huggingface.co/docs/trl](https://huggingface.co/docs/trl/sft_trainer)

---

## Kurzfassung (TL;DR)

1. Export: UI → Fine-Tuning-Export → `train.jsonl` + `val.jsonl`.
2. Installieren: Unsloth (einfach) oder mistral-finetune (offiziell).
3. Trainieren: `r=32`, `lr=2e-4`, 2 Epochen, bf16, Eval alle 200 Steps.
4. Stoppen, sobald Eval-Loss steigt.
5. Inferenz mit `temperature=0.8`, `repetition_penalty=1.05`, System-Prompt identisch zum Training.
6. Optional: in GGUF mergen und in Ollama als `OLLAMA_MODEL=buch-autor` in bookstack-lektorat einbinden.
