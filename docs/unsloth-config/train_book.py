"""
Unsloth-QLoRA-Training für Mistral-Small-3.2-24B-Instruct-2506 auf den
Fine-Tuning-Export-Daten.

Zielumgebung: 1× RTX 4000 Ada (20 GB VRAM). Single-GPU. Die zweite Karte im
System bleibt für Inferenz/Evaluation frei.

Hinweis: Mistral-Small-3.2 (24B) ist ~3× grösser als das vorherige Default
(Ministral-3-8B). VRAM-Profil ist deutlich enger — `batch_size=1` mit
`gradient_accumulation_steps=16` ist hier Pflicht. Bei OOM: `MAX_SEQ` von
4096 auf 2048 reduzieren.

Einsatz:
    conda activate unsloth
    CUDA_VISIBLE_DEVICES=0 python train_book.py

Erwartete Dateien im selben Ordner:
    train.jsonl   # aus UI-Export
    val.jsonl     # aus UI-Export

Ergebnis am Ende:
    runs/mistral-small32-buch/adapter/        # LoRA-Adapter (klein)
    runs/mistral-small32-buch/merged/         # bf16-Merge (vollgrösse, ~48 GB)
    runs/mistral-small32-buch/gguf/*.gguf     # Q4_K_M für Ollama (~14 GB)

Buchtitel unten anpassen (BOOK_TITLE).

Tokenizer-Hinweis: Mistral-Small-3.2 nutzt Tekken-V7 (Mistral-Common >= 1.6).
Chat-Template rendert weiterhin [INST]/[/INST] um Assistant-Antworten — der
`train_on_responses_only`-Wrapper unten validiert das via Probe.
"""

from unsloth import FastLanguageModel
from unsloth.chat_templates import train_on_responses_only
from datasets import load_dataset
from trl import SFTTrainer
from transformers import TrainingArguments, EarlyStoppingCallback

# ─────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────

BOOK_TITLE  = "Mein Buchtitel"   # nur für den Fallback-System-Prompt in der Inferenz
MODEL       = "unsloth/Mistral-Small-3.2-24B-Instruct-2506-unsloth-bnb-4bit"
MAX_SEQ     = 4096               # matcht finetune-export Empfehlung; bei OOM auf 2048
OUT_DIR     = "runs/mistral-small32-buch"

TRAIN_FILE  = "train.jsonl"
EVAL_FILE   = "val.jsonl"

# ─────────────────────────────────────────────────────────────────────────
# Modell + Tokenizer (4-bit)
# ─────────────────────────────────────────────────────────────────────────

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name      = MODEL,
    max_seq_length  = MAX_SEQ,
    load_in_4bit    = True,
    dtype           = None,       # auto bf16 auf Ampere+/Ada
)

# ─────────────────────────────────────────────────────────────────────────
# LoRA-Adapter
# r=32 ist der Sweet-Spot für "Buchwelt internalisieren" — genug Kapazität
# für Figuren/Orte/Beziehungen, ohne zu overfitten.
# alpha == r ist die moderne Unsloth-Empfehlung (früher alpha = 2×r).
#
# Vision-Hinweis: Mistral-Small-3.2 hat einen Pixtral-Vision-Encoder. Beim
# reinen Text-Finetuning dürfen Vision-Layer NICHT angefasst werden — sonst
# VRAM-Waste und mögliche Corruption, falls das Modell später wieder Bilder
# verarbeiten soll. Die expliziten `target_modules` beschränken die LoRA-
# Injection auf die Sprach-Layer (q/k/v/o + MLP), was denselben Effekt hat.
# ─────────────────────────────────────────────────────────────────────────

model = FastLanguageModel.get_peft_model(
    model,
    r                         = 32,
    lora_alpha                = 32,
    lora_dropout              = 0,    # Unsloth-patched: 0 = schnellste Variante
    bias                      = "none",
    target_modules            = ["q_proj", "k_proj", "v_proj", "o_proj",
                                 "gate_proj", "up_proj", "down_proj"],
    use_gradient_checkpointing= "unsloth",
    random_state              = 42,
    use_rslora                = False,
    loftq_config              = None,
)

# ─────────────────────────────────────────────────────────────────────────
# Daten
# ─────────────────────────────────────────────────────────────────────────

train_ds = load_dataset("json", data_files=TRAIN_FILE, split="train")
eval_ds  = load_dataset("json", data_files=EVAL_FILE,  split="train")

# Wenn der Export mit emit_text=true erzeugt wurde, existiert bereits ein
# text-Feld. Wir ignorieren es und rendern konsistent über die Chat-Template-
# Funktion des Tokenizers — das ist robuster gegen Template-Änderungen.
def fmt(example):
    return tokenizer.apply_chat_template(
        example["messages"],
        tokenize               = False,
        add_generation_prompt  = False,
    )

# ─────────────────────────────────────────────────────────────────────────
# Trainer
# packing=False: erhält Sample-Grenzen. Wichtig für pageCont/chapTrans-Samples
# im Export — Packing würde zwei unabhängige Fortsetzungen in eine Sequenz
# mischen und die Boundary-Semantik brechen.
# ─────────────────────────────────────────────────────────────────────────

trainer = SFTTrainer(
    model            = model,
    tokenizer        = tokenizer,
    train_dataset    = train_ds,
    eval_dataset     = eval_ds,
    formatting_func  = fmt,
    max_seq_length   = MAX_SEQ,
    packing          = False,
    args = TrainingArguments(
        output_dir                   = OUT_DIR,
        # Effektive Batch-Size = 1 × 16 = 16; VRAM-Peak ~17–19 GB auf 20 GB.
        # 24B-Modell verträgt keine batch_size=2 mehr auf 20 GB.
        per_device_train_batch_size  = 1,
        gradient_accumulation_steps  = 16,
        num_train_epochs             = 2,
        learning_rate                = 2e-4,
        warmup_ratio                 = 0.03,
        lr_scheduler_type            = "cosine",
        bf16                         = True,
        fp16                         = False,
        # adamw_8bit halbiert den Optimizer-State-VRAM — zusammen mit
        # bnb-4bit der VRAM-Schlüssel für Mistral-Small-3.2-24B auf 20 GB.
        optim                        = "adamw_8bit",
        weight_decay                 = 0.01,
        max_grad_norm                = 1.0,
        logging_steps                = 20,
        eval_strategy                = "steps",
        eval_steps                   = 200,
        save_strategy                = "steps",
        save_steps                   = 500,
        save_total_limit             = 3,
        load_best_model_at_end       = True,
        metric_for_best_model        = "eval_loss",
        greater_is_better            = False,
        seed                         = 42,
        report_to                    = "tensorboard",
        dataloader_num_workers       = 2,
    ),
    callbacks = [EarlyStoppingCallback(early_stopping_patience=3)],
)

# ─────────────────────────────────────────────────────────────────────────
# KRITISCH: Loss nur auf Assistant-Tokens.
# Ohne diesen Wrapper lernt das Modell auch aus unseren System-Prompts und
# User-Fragen → Stil verwässert, Paraphrasen aus authorChat werden fälschlich
# als "Produktion" gelernt statt als "Eingabe".
#
# Marker müssen exakt zum Chat-Template von Mistral-Small-3.2 passen. Tekken-V7
# rendert Instruction/Response weiterhin als [INST]/[/INST] — System-Prompts
# wandern in [SYSTEM_PROMPT]/[/SYSTEM_PROMPT], stören das Masking aber nicht.
# Probe direkt aus dem Tokenizer, damit ein späteres Template-Update früh
# knallt statt stumm zu maskieren.
# ─────────────────────────────────────────────────────────────────────────

_probe = tokenizer.apply_chat_template(
    [{"role": "user", "content": "x"}, {"role": "assistant", "content": "y"}],
    tokenize=False,
)
assert "[INST]" in _probe and "[/INST]" in _probe, (
    f"Unerwartetes Chat-Template — [INST]/[/INST]-Marker fehlen:\n{_probe}"
)

trainer = train_on_responses_only(
    trainer,
    instruction_part = "[INST]",
    response_part    = "[/INST]",
)

# ─────────────────────────────────────────────────────────────────────────
# Training
# ─────────────────────────────────────────────────────────────────────────

trainer.train()

# ─────────────────────────────────────────────────────────────────────────
# Adapter speichern (klein, ~400 MB bei 24B/r=32)
# ─────────────────────────────────────────────────────────────────────────

adapter_dir = f"{OUT_DIR}/adapter"
model.save_pretrained(adapter_dir)
tokenizer.save_pretrained(adapter_dir)
print(f"[✓] LoRA-Adapter gespeichert: {adapter_dir}")

# ─────────────────────────────────────────────────────────────────────────
# Merge zu bf16 + GGUF-Export für Ollama
# bf16-Merge: ~48 GB, rein für Debugging/Inferenz via HuggingFace nützlich.
# GGUF Q4_K_M: ~14 GB, für Ollama/llama.cpp — bei 24B ist Q5_K_M (~17 GB)
# auf 20-GB-Karten zur Inferenz zu eng (KV-Cache passt nicht mehr).
# ─────────────────────────────────────────────────────────────────────────

print("[ ] Merge zu bf16…")
model.save_pretrained_merged(
    f"{OUT_DIR}/merged",
    tokenizer,
    save_method = "merged_16bit",
)
print(f"[✓] Merged: {OUT_DIR}/merged")

print("[ ] GGUF-Export (Q4_K_M)…")
model.save_pretrained_gguf(
    f"{OUT_DIR}/gguf",
    tokenizer,
    quantization_method = "q4_k_m",
)
print(f"[✓] GGUF: {OUT_DIR}/gguf")

print()
print("Nächste Schritte:")
print(f"  cd {OUT_DIR}/gguf")
print(f"  ollama create buch-autor -f ../../../Modelfile.example")
print(f"  ollama run buch-autor 'Schreibe den Anfang eines neuen Kapitels.'")
print()
print(f"Danach in bookstack-lektorat: .env → OLLAMA_MODEL=buch-autor")
