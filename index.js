const EXTENSION_KEY = 'st_mobile_phone';
const PROMPT_TAG = 'st_mobile_phone_private_memory';

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

    // Auto-add the active main character as a default contact if present
    const char = ctx.characters?.[ctx.characterId];
    if (char && !data.contacts[`char_${ctx.characterId}`]) {
        const id = `char_${ctx.characterId}`;
        data.contacts[id] = {
            id,
            name: char.name,
            bio: char.description?.slice(0, 500) || '',
            unread: 0,
            isMainChar: true,
        };
        data.threads[id] = data.threads[id] || [];
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
 * Inject ONLY the currently replying character's private phone history
 * into the main chat prompt so other characters don't magically know about it.
 */
function syncPrivatePhoneMemoryToMainPrompt() {
    const ctx = getST();
    if (typeof ctx.setExtensionPrompt !== 'function') return;

    const data = ensurePhoneData();
    const activeChar = ctx.characters?.[ctx.characterId];
    if (!activeChar) {
        ctx.setExtensionPrompt(PROMPT_TAG, '', 1, 0);
        return;
    }

    // Match contact by name (works for both main char and named NPC contacts)
    const matchingContact = Object.values(data.contacts).find(
        (c) => c.name.toLowerCase() === activeChar.name.toLowerCase()
    );

    if (!matchingContact) {
        ctx.setExtensionPrompt(PROMPT_TAG, '', 1, 0);
        return;
    }

    const thread = (data.threads[matchingContact.id] || []).slice(-8);
    if (!thread.length) {
        ctx.setExtensionPrompt(PROMPT_TAG, '', 1, 0);
        return;
    }

    const formatted = thread
        .map((msg) => {
            const who = msg.sender === 'user' ? (ctx.name1 || 'User') : matchingContact.name;
            const extra = msg.meta?.summary ? ` [${msg.meta.summary}]` : '';
            return `- ${who}: ${msg.content}${extra}`;
        })
        .join('\n');

    const promptText = `[Private Mobile Phone History known ONLY to ${matchingContact.name} and ${ctx.name1 || 'User'}. Other characters have NO knowledge of these texts/calls unless told:\n${formatted}]`;

    // Depth 1, role system/extension prompt
    ctx.setExtensionPrompt(PROMPT_TAG, promptText, 1, 1);
}

/**
 * Ask the LLM to reply as a specific NPC on the phone using ONLY:
 * 1. Their bio
 * 2. Recent main-chat events
 * 3. Their own private phone thread (never other NPCs' threads!)
 */
async function generateNpcPhoneReply(contactId, incomingAttachmentContext = '') {
    const ctx = getST();
    const data = ensurePhoneData();
    const contact = data.contacts[contactId];
    const thread = (data.threads[contactId] || []).slice(-15);

    const historyText = thread
        .map((m) => {
            const who = m.sender === 'user' ? (ctx.name1 || 'User') : contact.name;
            const att = m.meta?.summary ? ` (${m.meta.summary})` : '';
            return `${who}: ${m.content}${att}`;
        })
        .join('\n');

    const prompt = `You are roleplaying as ${contact.name} texting ${ctx.name1 || 'User'} on a mobile phone.
Character/NPC Bio: ${contact.bio || 'An NPC in the ongoing story.'}

Recent events in the story (context ${contact.name} may react to):
${getRecentMainChatText(10)}

Private text/call history between ${contact.name} and ${ctx.name1 || 'User'} ONLY:
${historyText}
${incomingAttachmentContext ? `\nNew attachment details: ${incomingAttachmentContext}` : ''}

Write ${contact.name}'s next realistic text message(s). Keep it concise like real texting. Do not narrate actions unless brief/natural.`;

    const reply = await ctx.generateQuietPrompt(prompt, false, false);
    return (reply || '').trim();
}

/**
 * Proactive NPC texting: after a main-chat message arrives, optionally check
 * whether an NPC wants to text the user about what just happened.
 */
async function maybeTriggerProactiveNpcText() {
    const ctx = getST();
    const data = ensurePhoneData();
    const contacts = Object.values(data.contacts);
    if (!contacts.length) return;

    // Pick a contact at random (or refine to NPCs currently off-screen)
    const contact = contacts[Math.floor(Math.random() * contacts.length)];
    const thread = (data.threads[contact.id] || []).slice(-6);
    const historyText = thread.map((m) => `${m.sender}: ${m.content}`).join('\n');

    const prompt = `Based on the latest roleplay events below, would ${contact.name} (${contact.bio || 'NPC'}) send a spontaneous text message to ${ctx.name1 || 'User'} right now?
Only reply YES if it makes strong narrative sense.

Recent roleplay:
${getRecentMainChatText(6)}

Private phone history with ${contact.name}:
${historyText || '(none)'}

Respond STRICTLY in JSON: {"send": true/false, "message": "text here or empty"}`;

    try {
        const raw = await ctx.generateQuietPrompt(prompt, false, false);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return;
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.send && parsed.message) {
            data.threads[contact.id] = data.threads[contact.id] || [];
            data.threads[contact.id].push({
                id: crypto.randomUUID(),
                sender: 'npc',
                type: 'text',
                content: parsed.message,
                timestamp: Date.now(),
            });
            contact.unread = (contact.unread || 0) + 1;
            await savePhoneData();
            renderPhoneUI();
            if (window.toastr) {
                toastr.info(`${contact.name}: ${parsed.message.slice(0, 80)}`, 'New Text Message');
            }
        }
    } catch (err) {
        console.warn('[ST Mobile Phone] Proactive text check skipped:', err);
    }
}

// ---------- UI & Call State ----------
let activeCall = null;
let pendingAttachment = null;

function updateUnreadBadge() {
    const data = ensurePhoneData();
    const total = Object.values(data.contacts).reduce((sum, c) => sum + (c.unread || 0), 0);
    const badge = document.getElementById('st-phone-badge');
    if (!badge) return;
    badge.textContent = total;
    badge.style.display = total > 0 ? 'flex' : 'none';
}

function renderPhoneUI() {
    const shell = document.getElementById('st-phone-shell');
    if (!shell) return;

    const data = ensurePhoneData();
    const headerTitle = shell.querySelector('#st-phone-title');
    const backBtn = shell.querySelector('#st-phone-back');
    const callBtn = shell.querySelector('#st-phone-call-btn');
    const addBtn = shell.querySelector('#st-phone-add-btn');
    const body = shell.querySelector('#st-phone-body');
    const composer = shell.querySelector('#st-phone-composer');

    updateUnreadBadge();

    if (!data.activeContactId || !data.contacts[data.activeContactId]) {
        // Contacts View
        headerTitle.textContent = 'Messages & Contacts';
        backBtn.style.display = 'none';
        callBtn.style.display
