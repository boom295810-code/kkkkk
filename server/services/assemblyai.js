const { AssemblyAI } = require('assemblyai');


const getTranscriptAndTimestamps = async (filePath, clientApiKey, isFreeUser = false) => {
  try {
    let words = [];
    try {
      const apiKey = clientApiKey || process.env.ASSEMBLYAI_API_KEY;
      if (!apiKey) {
        throw new Error('AssemblyAI API Key is required');
      }

      const client = new AssemblyAI({ apiKey });

      // Upload the file first
      console.log('[AssemblyAI] Uploading file...');
      const uploadUrl = await client.files.upload(filePath);

      console.log('[AssemblyAI] Transcribing...');
      // Create transcript
      const transcript = await client.transcripts.transcribe({
        audio: uploadUrl,
        language_detection: true,
        speaker_labels: true,
      });

      if (transcript.status === 'error') {
        throw new Error(transcript.error);
      }

      if (!transcript.words || transcript.words.length === 0) {
        throw new Error('No speech detected in the video.');
      }

      words = transcript.words;
    } catch (error) {
      if (isFreeUser) {
        console.warn('[AssemblyAI] Failed for Free User. Blocking fallback.', error.message);
        throw new Error(`AssemblyAI Error: ${error.message}. Please check your API key.`);
      }
      console.warn('[AssemblyAI] Failed:', error.message, '- Falling back to Groq');
      const groqKey = process.env.GROQ_API_KEY;
      if (!groqKey) throw new Error('Groq API Key is missing for fallback.');

      const Groq = require('groq-sdk');
      const groq = new Groq({ apiKey: groqKey });
      const fs = require('fs');

      console.log('[Groq] Transcribing with whisper-large-v3...');
      const transcript = await groq.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: 'whisper-large-v3',
        response_format: 'verbose_json',
        timestamp_granularities: ['word']
      });

      if (!transcript.words || transcript.words.length === 0) {
        throw new Error('No speech detected in the video (Groq).');
      }

      words = transcript.words.map(w => ({
        text: w.word,
        start: w.start * 1000,
        end: w.end * 1000,
        speaker: 'A'
      }));
    }


    // Group into scene blocks directly from words
    const blocks = [];
    let currentBlock = [];
    let currentSpeaker = words[0].speaker;

    for (let i = 0; i < words.length; i++) {
      const word = words[i];

      // A speaker change ALWAYS starts a new block — current word goes into new block
      if (word.speaker !== currentSpeaker) {
        if (currentBlock.length > 0) {
          blocks.push(currentBlock);
        }
        currentBlock = [word];
        currentSpeaker = word.speaker;
        continue;
      }

      currentBlock.push(word);

      if (currentBlock.length === 1) continue;

      // prevWord is the word just before the current one
      const prevWord = currentBlock[currentBlock.length - 2];
      // Duration from the first word of this block to current word's end (ms)
      const blockDuration = word.end - currentBlock[0].start;
      // Silence gap between prevWord and current word (ms)
      const pause = word.start - prevWord.end;

      // Check punctuation on prevWord (the word ending before current)
      const textToTest = prevWord.text;
      const isSentenceEnd = /[.!?]$/.test(textToTest);
      const isClauseEnd = /[,;]$/.test(textToTest) || /，$/.test(textToTest);

      if (blockDuration >= 3000) {
        if (isSentenceEnd || isClauseEnd || pause >= 900 || blockDuration >= 10000) {
          // ── FIX: pop current word out BEFORE pushing the block ──
          // The split point is BETWEEN prevWord and word:
          //   old block ends at prevWord.end
          //   new block starts at word.start (correct semantic boundary)
          currentBlock.pop();
          if (currentBlock.length > 0) {
            blocks.push(currentBlock);
          }
          currentBlock = [word]; // current word begins the new block
        }
      }
    }
    if (currentBlock.length > 0) {
      blocks.push(currentBlock);
    }

    // Tag and format each block
    let taggedBlocks = blocks.map((block, index) => {
      let speaker = block[0].speaker;
      let prevSpeaker = index > 0 ? blocks[index - 1][0].speaker : speaker;
      let nextSpeaker = index < blocks.length - 1 ? blocks[index + 1][0].speaker : speaker;

      let isDialogue = false;
      if (blocks.length > 1 && (speaker !== prevSpeaker || speaker !== nextSpeaker)) {
        isDialogue = true;
      }

      const text = block.map(w => w.text).join(' ');
      const start = block[0].start;
      const end = block[block.length - 1].end;

      return {
        start: start,
        end: end,
        text: text,
        speaker: speaker,
        tag: isDialogue ? 'dialogue' : 'narration',
        words: block // Keep words for later precise timing if needed
      };
    });

    // Drop any block over 45 characters per second (bad transcription)
    taggedBlocks = taggedBlocks.filter(b => {
      const durationSec = Math.max((b.end - b.start) / 1000, 0.1);
      const charsPerSec = b.text.length / durationSec;
      if (charsPerSec > 45) {
        console.log(`[AssemblyAI] Dropping block due to high char/sec (${charsPerSec.toFixed(1)}): ${b.text}`);
        return false;
      }
      return true;
    });

    return taggedBlocks;

  } catch (error) {
    console.error('Error in AssemblyAI transcription:', error);
    throw error;
  }
};

module.exports = { getTranscriptAndTimestamps };
