#!/usr/bin/env python3
"""Import Claude data export into PH-Brain vault."""

import json
import os
import re
from datetime import datetime
from pathlib import Path

# Paths
EXPORT_DIR = os.path.expanduser("~/Downloads/claude-export")
VAULT_DIR = os.path.expanduser("~/PH-Brain")

CONVERSATIONS_FILE = os.path.join(EXPORT_DIR, "conversations.json")
MEMORIES_FILE = os.path.join(EXPORT_DIR, "memories.json")
PROJECTS_FILE = os.path.join(EXPORT_DIR, "projects.json")

CONV_OUT = os.path.join(VAULT_DIR, "sources/claude-conversations")
MEM_OUT = os.path.join(VAULT_DIR, "sources/claude-memories")
PROJ_OUT = os.path.join(VAULT_DIR, "sources/claude-projects")


def sanitize_filename(name):
    if not name or not name.strip():
        return "untitled"
    name = re.sub(r'[^\w\s-]', '', name).strip()
    name = re.sub(r'[-\s]+', '-', name)
    return name[:80] if name else "untitled"


def extract_message_text(msg):
    """Extract text from a message, handling both old and new formats."""
    top_text = msg.get('text', '').strip()
    if top_text:
        return top_text
    
    content_blocks = msg.get('content', [])
    texts = []
    for block in content_blocks:
        block_type = block.get('type', '')
        if block_type == 'text':
            text = block.get('text', '').strip()
            if text:
                texts.append(text)
        elif block_type == 'thinking':
            thinking = block.get('thinking', '').strip()
            if thinking:
                texts.append(f"<thinking>\n{thinking}\n</thinking>")
        elif block_type == 'tool_use':
            tool_name = block.get('name', 'unknown')
            texts.append(f"[tool_use: {tool_name}]")
        elif block_type == 'tool_result':
            result = block.get('content', '')
            if isinstance(result, list):
                for item in result:
                    if isinstance(item, dict) and item.get('type') == 'text':
                        texts.append(f"[tool_result]\n{item.get('text', '')}")
            elif isinstance(result, str):
                texts.append(f"[tool_result]\n{result}")
    
    return '\n\n'.join(texts)


def convert_conversation(conv):
    title = conv.get('name', '').strip() or 'Untitled'
    created = conv.get('created_at', '')
    updated = conv.get('updated_at', '')
    uuid = conv.get('uuid', '')
    summary = conv.get('summary', '').strip()
    messages = conv.get('chat_messages', [])
    
    lines = ["---",
             f"title: {title}",
             f"created: {created}",
             f"updated: {updated}",
             f"uuid: {uuid}",
             "source: claude-conversation",
             "type: source",
             f"message_count: {len(messages)}",
             "---",
             "",
             f"# {title}",
             ""]
    
    if summary:
        lines.append(f"*Summary: {summary}*")
        lines.append("")
    
    for msg in messages:
        sender = msg.get('sender', 'unknown')
        text = extract_message_text(msg)
        if not text:
            continue
        
        role_label = "## Phelipe" if sender == 'human' else "## Claude"
        lines.extend([role_label, "", text, "", "---", ""])
    
    return '\n'.join(lines)


def import_conversations():
    print("=== Importing Conversations ===")
    Path(CONV_OUT).mkdir(parents=True, exist_ok=True)
    
    with open(CONVERSATIONS_FILE, 'r') as f:
        data = json.load(f)
    
    print(f"Found {len(data)} conversations total")
    
    converted = 0
    skipped_empty = 0
    skipped_no_content = 0
    
    for conv in data:
        messages = conv.get('chat_messages', [])
        if len(messages) == 0:
            skipped_empty += 1
            continue
        
        has_content = any(extract_message_text(m).strip() for m in messages)
        if not has_content:
            skipped_no_content += 1
            continue
        
        title = conv.get('name', '').strip()
        created = conv.get('created_at', '')
        
        try:
            date = datetime.fromisoformat(created.replace('Z', '+00:00'))
            date_prefix = date.strftime('%Y-%m-%d')
        except:
            date_prefix = 'undated'
        
        safe_title = sanitize_filename(title)
        filename = f"{date_prefix}-{safe_title}.md"
        filepath = os.path.join(CONV_OUT, filename)
        
        if os.path.exists(filepath):
            short_uuid = conv.get('uuid', '')[:8]
            filename = f"{date_prefix}-{safe_title}-{short_uuid}.md"
            filepath = os.path.join(CONV_OUT, filename)
        
        markdown = convert_conversation(conv)
        with open(filepath, 'w') as f:
            f.write(markdown)
        
        converted += 1
        if converted % 100 == 0:
            print(f"  Processed {converted}...")
    
    print(f"\n  Converted:            {converted}")
    print(f"  Skipped (empty):      {skipped_empty}")
    print(f"  Skipped (no content): {skipped_no_content}")
    print()


def import_memories():
    print("=== Importing Memories ===")
    Path(MEM_OUT).mkdir(parents=True, exist_ok=True)
    
    with open(MEMORIES_FILE, 'r') as f:
        data = json.load(f)
    
    if not data or not isinstance(data, list):
        print("  No memories found")
        return
    
    for i, mem in enumerate(data):
        memory_text = mem.get('conversations_memory', '').strip()
        if not memory_text:
            continue
        
        timestamp = datetime.now().strftime('%Y-%m-%d')
        filename = f"{timestamp}-claude-memory-snapshot.md"
        filepath = os.path.join(MEM_OUT, filename)
        
        content = [
            "---",
            f"title: Claude Memory Snapshot",
            f"exported_date: {timestamp}",
            "source: claude-memories",
            "type: source",
            "---",
            "",
            "# Claude Memory Snapshot",
            "",
            "*This is Claude's accumulated memory about Phelipe as of the export date. "
            "It represents synthesized context across past conversations.*",
            "",
            memory_text
        ]
        
        with open(filepath, 'w') as f:
            f.write('\n'.join(content))
        
        print(f"  Wrote: {filename}")
    print()


def import_projects():
    print("=== Importing Projects ===")
    Path(PROJ_OUT).mkdir(parents=True, exist_ok=True)
    
    with open(PROJECTS_FILE, 'r') as f:
        data = json.load(f)
    
    if not data:
        print("  No projects found")
        return
    
    print(f"Found {len(data)} projects")
    
    for proj in data:
        name = proj.get('name', '').strip() or 'Untitled Project'
        description = proj.get('description', '').strip()
        instructions = proj.get('prompt_template', '').strip()
        uuid = proj.get('uuid', '')
        is_starter = proj.get('is_starter_project', False)
        docs = proj.get('docs', [])
        created = proj.get('created_at', '')
        
        # Skip starter projects (Anthropic's examples)
        if is_starter:
            print(f"  Skipping starter: {name}")
            continue
        
        safe_name = sanitize_filename(name)
        
        try:
            date = datetime.fromisoformat(created.replace('+00:00', ''))
            date_prefix = date.strftime('%Y-%m-%d')
        except:
            date_prefix = 'undated'
        
        # Create project folder
        proj_folder = os.path.join(PROJ_OUT, f"{date_prefix}-{safe_name}")
        Path(proj_folder).mkdir(parents=True, exist_ok=True)
        
        # Write project metadata + instructions
        meta_lines = [
            "---",
            f"title: {name}",
            f"created: {created}",
            f"uuid: {uuid}",
            "source: claude-project",
            "type: source",
            "---",
            "",
            f"# {name}",
            ""
        ]
        
        if description:
            meta_lines.extend([f"**Description:** {description}", ""])
        
        if instructions:
            meta_lines.extend([
                "## Project Instructions",
                "",
                instructions,
                ""
            ])
        
        if docs:
            meta_lines.extend([
                "## Attached Documents",
                "",
                f"This project has {len(docs)} attached documents (see sibling files)",
                ""
            ])
        
        index_path = os.path.join(proj_folder, "_project.md")
        with open(index_path, 'w') as f:
            f.write('\n'.join(meta_lines))
        
        # Write each doc as a separate file
        for doc in docs:
            doc_filename = doc.get('filename', 'untitled.md')
            doc_content = doc.get('content', '')
            doc_uuid = doc.get('uuid', '')[:8]
            
            # Sanitize the doc filename
            safe_doc_name = sanitize_filename(doc_filename.replace('.md', ''))
            doc_path = os.path.join(proj_folder, f"{safe_doc_name}.md")
            
            if os.path.exists(doc_path):
                doc_path = os.path.join(proj_folder, f"{safe_doc_name}-{doc_uuid}.md")
            
            doc_lines = [
                "---",
                f"title: {doc_filename}",
                f"project: {name}",
                f"doc_uuid: {doc.get('uuid', '')}",
                "source: claude-project-doc",
                "type: source",
                "---",
                "",
                doc_content
            ]
            
            with open(doc_path, 'w') as f:
                f.write('\n'.join(doc_lines))
        
        print(f"  Imported: {name} ({len(docs)} docs)")
    print()


def main():
    print("Starting Claude export import to PH-Brain")
    print(f"Export source: {EXPORT_DIR}")
    print(f"Vault target:  {VAULT_DIR}")
    print()
    
    import_memories()
    import_projects()
    import_conversations()
    
    print("=== Import Complete ===")
    print(f"All content is in: {VAULT_DIR}/sources/")


if __name__ == '__main__':
    main()
