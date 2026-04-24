"""
Unsloth-QLoRA-Training für Ministral-3-8B-Instruct-2512 auf den Fine-Tuning-
Export-Daten.

Zielumgebung: 1× RTX 4000 Ada (20 GB VRAM). Single-GPU. Die zweite Karte im
System bleibt für Inferenz/Evaluation frei.

Einsatz:
    conda activate unsloth
    CUDA_VISIBLE_DEVICES=0 python train_book.py

Erwartete Dateien im selben Ordner:
    train.jsonl   # aus UI-Export
    val.jsonl     # aus UI-Export

Ergebnis am Ende:
    runs/ministral3-buch/adapter/        # LoRA-Adapter (klein)
    runs/ministral3-buch/merged/         # bf16-Merge (vollgrösse)
    runs/ministral3-buch/gguf/*.gguf     # Q5_K_M für Ollama

Buchtitel unten anpassen (BOOK_TITLE).

Tokenizer-Hinweis: Ministral-3 nutzt Mistral-Common >= 1.8.6 (wird durch die
pinned requirements.txt mitinstalliert). Die Assistant-Marker bleiben
[INST]/[/INST] — unten in `train_on_responses_only` validiert.
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
MODEL       = "unsloth/Ministral-3-8B-Instruct-2512-unsloth-bnb-4bit"
MAX_SEQ     = 4096               # matcht finetune-export Empfehlung
OUT_DIR     = "runs/ministral3-buch"

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
# Vision-Hinweis: Ministral-3 ist multimodal (0.4 B Vision-Encoder). Beim
# reinen Text-Finetuning dürfen die Vision-Layer NICHT angefasst werden —
# sonst VRAM-Waste und mögliche Corruption, wenn das Modell später wieder
# Bilder verarbeiten soll. Falls Unsloth in einer späteren Version einen
# `finetune_vision_layers=False`-Kwarg exponiert, hier setzen. Aktuell
# beschränken die expliziten `target_modules` die LoRA-Injection auf die
# Sprach-Layer (q/k/v/o + MLP), was denselben Effekt hat.
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
        # Effektive Batch-Size = 2 × 8 = 16; VRAM-Peak ~14–16 GB auf 20 GB.
        per_device_train_batch_size  = 2,
        gradient_accumulation_steps  = 8,
        num_train_epochs             = 2,
        learning_rate                = 2e-4,
        warmup_ratio                 = 0.03,
        lr_scheduler_type            = "cosine",
        bf16                         = True,
        fp16                         = False,
        # adamw_8bit halbiert den Optimizer-State-VRAM — zusammen mit
        # bnb-4bit ist das der VRAM-Schlüssel für Ministral-3-8B auf 20 GB.
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
# Marker müssen exakt zum Chat-Template von Ministral-3 passen. Mistral-Common
# >= 1.8.6 rendert weiterhin [INST]/[/INST] um Instruction/Response — deshalb
# unveränderte Marker gegenüber dem 2410-Vorgänger. Validation direkt aus dem
# Tokenizer, damit ein späteres Template-Update (ohne dass wir's merken) früh
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
# Adapter speichern (klein, ~200 MB)
# ─────────────────────────────────────────────────────────────────────────

adapter_dir = f"{OUT_DIR}/adapter"
model.save_pretrained(adapter_dir)
tokenizer.save_pretrained(adapter_dir)
print(f"[✓] LoRA-Adapter gespeichert: {adapter_dir}")

# ─────────────────────────────────────────────────────────────────────────
# Merge zu bf16 + GGUF-Export für Ollama
# bf16-Merge: ~16 GB, rein für Debugging/Inferenz via HuggingFace nützlich.
# GGUF Q5_K_M: ~5.5 GB, für Ollama/llama.cpp — bester Quality/Size-Kompromiss
# für 8B-Modelle.
# ─────────────────────────────────────────────────────────────────────────

print("[ ] Merge zu bf16…")
model.save_pretrained_merged(
    f"{OUT_DIR}/merged",
    tokenizer,
    save_method = "merged_16bit",
)
print(f"[✓] Merged: {OUT_DIR}/merged")

print("[ ] GGUF-Export (Q5_K_M)…")
model.save_pretrained_gguf(
    f"{OUT_DIR}/gguf",
    tokenizer,
    quantization_method = "q5_k_m",
)
print(f"[✓] GGUF: {OUT_DIR}/gguf")

print()
print("Nächste Schritte:")
print(f"  cd {OUT_DIR}/gguf")
print(f"  ollama create buch-autor -f ../../../Modelfile.example")
print(f"  ollama run buch-autor 'Schreibe den Anfang eines neuen Kapitels.'")
print()
print(f"Danach in bookstack-lektorat: .env → OLLAMA_MODEL=buch-autor")
