const EXTENSION_KEY = 'st_mobile_phone';
const PROMPT_TAG = 'st_mobile_phone_private_memory';

let activeCall = null;
let pendingAttachment = null;
let autoProactiveEnabled = true;

function getST() {
    return SillyTavern.getContext();
}

function escapeHtml(str = '') {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function ensurePhoneData() {
    const ctx = getST();
    if (!ctx.chatMetadata) ctx.chatMetadata = {};
    if (!ctx.chatMetadata[EXTENSION_KEY]) {
        ctx.chatMetadata[EXTENSION_KEY] = {
            contacts: {},
            threads: {},
            activeContactId: null,
        };
    }

    const data = ctx.chatMetadata[EXTENSION_KEY];

    // Auto-add the active main character if not present
    const char = ctx.characters?.[ctx.characterId];
    if (char) {
        const id = `char_${ctx.characterId}`;
        if (!data.contacts[id]) {
            data.contacts[id] = {
                id,
                name: char.name,
                bio: (char.description || '').slice(0, 500),
                unread: 0,
                isMainChar: true,
            };
            data.threads[id] = data.threads[id] || [];
        }
    }

    return data;
}

async function savePhoneData() {
    const ctx = getST();
    if (typeof ctx.saveMetadata === 'function') {
        await ctx.saveMetadata();
    }
}

function getRecentMainChatText(limit = 12) {
    const ctx = getST();
    const chat = ctx.chat || [];
    return chat
        .slice(-limit)
        .map((m) => `${m.name}: ${m.mes}`)
        .join('\n');
}

/**
 * Determine which character is about to speak in the main chat
 * (supports single character chats and group chats).
 */
function getCurrentSpeakerName(eventData) {
    const ctx = getST();
    if (eventData?.charName) return eventData.charName;
    if (typeof eventData === 'string') return eventData;

    const char = ctx.characters?.[ctx.characterId];
    if (char?.name) return char.name;

    // Fallback in group chats: look at last non-user speaker or group name
    if (ctx.groupId && Array.isArray(ctx.groups)) {
        const group = ctx.groups.find((g) => g.id === ctx.groupId);
        if (group?.members?.length === 1) {
            const member = ctx.characters?.find((c) => c.avatar === group.members[0]);
            if (member) return member.name;
        }
    }
    return null;
}

/**
 * Inject ONLY the currently replying character's private phone history
 * into the main chat prompt so other characters do not know about it.
 */
function syncPrivatePhoneMemoryToMainPrompt(eventData = null) {
    const ctx = getST();
    if (typeof ctx.setExtensionPrompt !== 'function') return;

    const data = ensurePhoneData();
    const speakerName = getCurrentSpeakerName(eventData);

    if (!speakerName) {
        ctx.setExtensionPrompt(PROMPT_TAG, '', 1, 0);
        return;
    }

    const matchingContact = Object.values(data.contacts).find(
        (c) => c.name.toLowerCase() === speakerName.toLowerCase()
    );

    if (!matchingContact) {
        ctx.setExtensionPrompt(PROMPT_TAG, '', 1, 0);
        return;
    }

    const thread = (data.threads[matchingContact.id] || []).slice(-10);
    if (!thread.length) {
        ctx.setExtensionPrompt(PROMPT_TAG, '', 1, 0);
        return;
    }

    const userName = ctx.name1 || 'User';
    const formatted = thread
        .map((msg) => {
            const who = msg.sender === 'user' ? userName : matchingContact.name;
            const extra = msg.meta?.summary ? ` [${msg.meta.summary}]` : '';
            return `- (${msg.type}) ${who}: ${msg.content}${extra}`;
        })
        .join('\n');

    const promptText = `[Private Mobile Phone History known ONLY to ${matchingContact.name} and ${userName}. Other characters in the story have NO knowledge of these texts/calls unless explicitly told:\n${formatted}]`;

    ctx.setExtensionPrompt(PROMPT_TAG, promptText, 1, 1);
}

/**
 * Generate an NPC reply on the phone using ONLY:
 * 1. Their bio
 * 2. Recent main-chat events
 * 3. Their own private phone thread
 */
async function generateNpcPhoneReply(contactId, incomingAttachmentContext = '') {
    const ctx = getST();
    const data = ensurePhoneData();
    const contact = data.contacts[contactId];
    if (!contact) return '';

    const thread = (data.threads[contactId] || []).slice(-15);
    const userName = ctx.name1 || 'User';

    const historyText = thread
        .map((m) => {
            const who = m.sender === 'user' ? userName : contact.name;
            const att = m.meta?.summary ? ` (${m.meta.summary})` : '';
            return `${who}: ${m.content}${att}`;
        })
        .join('\n');

    const prompt = `You are roleplaying as ${contact.name} texting ${userName} on a mobile phone.
Character/NPC Bio: ${contact.bio || 'An NPC in the ongoing story.'}

Recent events in the story (context ${contact.name} may react to):
${getRecentMainChatText(10) || '(No main chat messages yet.)'}

Private text/call history between ${contact.name} and ${userName} ONLY:
${historyText || '(Start of conversation)'}
${incomingAttachmentContext ? `\nNew attachment details from ${userName}: ${incomingAttachmentContext}` : ''}

Write ${contact.name}'s next realistic text message(s). Keep it concise and natural like real texting. Do not narrate physical actions unless brief.`;

    const reply = await ctx.generateQuietPrompt(prompt, false, false);
    return (reply || '').trim();
}

/**
 * Check if an NPC wants to proactively text the user about recent main-chat events.
 */
async function maybeTriggerProactiveNpcText(force = false) {
    if (!force && !autoProactiveEnabled) return;

    const ctx = getST();
    const data = ensurePhoneData();
    const contacts = Object.values(data.contacts);
    if (!contacts.length) return;

    // 35% chance on automatic triggers unless forced via button
    if (!force && Math.random() > 0.35) return;

    const contact = contacts[Math.floor(Math.random() * contacts.length)];
    const thread = (data.threads[contact.id] || []).slice(-6);
    const userName = ctx.name1 || 'User';
    const historyText = thread
        .map((m) => `${m.sender === 'user' ? userName : contact.name}: ${m.content}`)
        .join('\n');

    const prompt = `Based on the latest roleplay events below, would ${contact.name} (${contact.bio || 'NPC'}) send a spontaneous text message to ${userName} right now?
Only reply true if it fits their personality and the story.

Recent roleplay:
${getRecentMainChatText(6) || '(none)'}

Private phone history with ${contact.name}:
${historyText || '(none)'}

Respond STRICTLY in JSON: {"send": true/false, "message": "text here or empty"}`;

    try {
        const raw = await ctx.generateQuietPrompt(prompt, false, false);
        const jsonMatch = (raw || '').match(/\{[\s\S]*\}/);
        if (!jsonMatch) return;
        const parsed = JSON.parse(jsonMatch[0]);

        if (parsed.send && parsed.message) {
            data.threads[contact.id] = data.threads[contact.id] || [];
            data.threads[contact.id].push({
                id: crypto.randomUUID(),
                sender: 'npc',
                type: 'text',
                content: parsed.message.trim(),
                timestamp: Date.now(),
            });
            if (data.activeContactId !== contact.id || !document.getElementById('st-phone-shell')?.classList.contains('open')) {
                contact.unread = (contact.unread || 0) + 1;
            }
            await savePhoneData();
            renderPhoneUI();
            if (window.toastr) {
                toastr.info(`${contact.name}: ${parsed.message.slice(0, 80)}`, 'New Phone Text');
            }
        } else if (force && window.toastr) {
            toastr.info(`${contact.name} had nothing to text right now.`, 'Phone');
        }
    } catch (err) {
        console.warn('[ST Mobile Phone] Proactive text check failed:', err);
    }
}

// ---------- Attachments (Photo / File / Link) ----------

function setPendingAttachment(att) {
    pendingAttachment = att;
    const preview = document.getElementById('st-phone-att-preview');
    if (!preview) return;
    if (!att) {
        preview.style.display = 'none';
        preview.innerHTML = '';
        return;
    }
    preview.style.display = 'flex';
    preview.innerHTML = `
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📎 ${escapeHtml(att.label)}</span>
        <button type="button" id="st-phone-att-clear" class="st-phone-btn" style="padding:2px 6px;">✕</button>
    `;
    document.getElementById('st-phone-att-clear')?.addEventListener('click', () => setPendingAttachment(null));
}

async function handleFileUpload(file) {
    if (!file) return;

    if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => {
            const caption = prompt('Optional description of this photo (helps non-vision models see it):', `Photo: ${file.name}`) || `Photo: ${file.name}`;
            setPendingAttachment({
                type: 'image',
                label: file.name,
                dataUrl: reader.result,
                summary: `Sent photo (${file.name}): ${caption}`,
            });
        };
        reader.readAsDataURL(file);
        return;
    }

    // Text-based files (.txt, .md, .json, .csv, .log, etc.)
    try {
        const text = await file.text();
        const snippet = text.slice(0, 2500);
        setPendingAttachment({
            type: 'file',
            label: file.name,
            fileName: file.name,
            fileSize: file.size,
            extractedText: snippet,
            summary: `Sent file "${file.name}". Contents:\n${snippet}`,
        });
    } catch {
        setPendingAttachment({
            type: 'file',
            label: file.name,
            fileName: file.name,
            fileSize: file.size,
            summary: `Sent file "${file.name}" (${file.size} bytes).`,
        });
    }
}

function handleAttachLink() {
    const url = prompt('Paste URL to send:');
    if (!url || !url.trim()) return;
    const note = prompt('Optional note about what this link shows (so the character knows what is on the page):', '') || '';
    const cleanUrl = url.trim();
    setPendingAttachment({
        type: 'link',
        label: cleanUrl,
        url: cleanUrl,
        note,
        summary: `Sent link: ${cleanUrl}${note ? ` — Context: ${note}` : ''}`,
    });
}

// ---------- Sending Messages ----------

async function sendPhoneMessage() {
    const data = ensurePhoneData();
    const contactId = data.activeContactId;
    if (!contactId || !data.contacts[contactId]) return;

    const input = document.getElementById('st-phone-input');
    const text = (input?.value || '').trim();
    if (!text && !pendingAttachment) return;

    const att = pendingAttachment;
    if (input) input.value = '';
    setPendingAttachment(null);

    data.threads[contactId] = data.threads[contactId] || [];
    data.threads[contactId].push({
        id: crypto.randomUUID(),
        sender: 'user',
        type: att ? att.type : 'text',
        content: text || (att ? `[Sent ${att.type}]` : ''),
        meta: att ? { ...att } : undefined,
        timestamp: Date.now(),
    });

    await savePhoneData();
    renderPhoneUI();

    // Generate NPC reply
    const typingEl = document.getElementById('st-phone-typing');
    if (typingEl) typingEl.style.display = 'block';

    try {
        const reply = await generateNpcPhoneReply(contactId, att?.summary || '');
        if (reply) {
            data.threads[contactId].push({
                id: crypto.randomUUID(),
                sender: 'npc',
   
