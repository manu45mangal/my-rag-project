require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Pinecone } = require('@pinecone-database/pinecone');

// --- Initialization ---
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Configure Multer to temporarily store uploaded files
// We are explicitly expecting the field name 'document' to match the LWC
const upload = multer({ dest: 'uploads/' }); 

// Initialize Pinecone globally!
const pc = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY
});
// Replace 'your-index-name' with your actual Pinecone index name
const pineconeIndex = pc.index(process.env.PINECONE_INDEX_NAME || "your-index-name"); 

// ==========================================
// ROUTE 1: Get Active Namespaces (Dashboard)
// ==========================================
app.get('/api/namespaces', async (req, res) => {
    try {
        const stats = await pineconeIndex.describeIndexStats();
        const activeNamespaces = Object.keys(stats.namespaces || {});
        res.status(200).json({ namespaces: activeNamespaces });
    } catch (error) {
        console.error("Error fetching namespaces:", error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// ROUTE 2: Delete a Namespace (Dashboard)
// ==========================================
app.delete('/api/namespaces/:namespace', async (req, res) => {
    try {
        const targetNamespace = req.params.namespace;
        await pineconeIndex.namespace(targetNamespace).deleteAll();
        res.status(200).json({ message: `Namespace "${targetNamespace}" successfully deleted.` });
    } catch (error) {
        console.error("Error deleting namespace:", error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// ROUTE 3: Upload & Embed Document
// ==========================================
app.post('/api/upload', upload.single('document'), async (req, res) => {
    try {
        const file = req.file;
        const namespace = req.body.namespace;

        if (!file || !namespace) {
            return res.status(400).json({ error: "Missing document or namespace." });
        }

        console.log(`Processing file for namespace: ${namespace}`);

        // ---------------------------------------------------------
        // PASTE YOUR EXISTING DOCUMENT PROCESSING CODE HERE:
        // 1. Extract text from the PDF/Word doc (req.file.path)
        // 2. Chunk the text
        // 3. Convert chunks to embeddings via your LLM
        // 4. Upsert vectors into Pinecone using: 
        //    pineconeIndex.namespace(namespace).upsert(vectors)
        // ---------------------------------------------------------

        res.status(200).json({ message: "Upload and embedding successful!" });
    } catch (error) {
        console.error("Upload route error:", error);
        res.status(500).json({ error: "Failed to process document." });
    }
});

// ==========================================
// ROUTE 4: AI Chat (RAG Rertrieval)
// ==========================================
app.post('/api/chat', async (req, res) => {
    try {
        const { question, namespace } = req.body;

        if (!question || !namespace) {
            return res.status(400).json({ error: "Missing question or namespace." });
        }

        // STEP 1: Search Pinecone using the PURE question!
        // ---------------------------------------------------------
        // PASTE YOUR EXISTING PINECONE SEARCH CODE HERE:
        // 1. Convert 'question' into an embedding
        // 2. Query Pinecone: pineconeIndex.namespace(namespace).query(...)
        // 3. Extract the matching text blocks into a 'context' variable
        // ---------------------------------------------------------
        
        let context = "Extracted context from Pinecone goes here..."; // Replace with your actual context variable

        // STEP 2: Append the secret HTML instruction for the AI
        const formattingInstruction = `
            (CRITICAL INSTRUCTION: Format your entire response using clean, structural HTML tags like <h3>, <p>, <ul>, <li>, and <strong>. 
            Do NOT use markdown symbols like ** or ###. Return ONLY the raw HTML string.)
        `;

        const finalPrompt = `
            Answer the user's question based ONLY on the following context.
            
            Context: ${context}
            
            User Question: ${question}
            
            ${formattingInstruction} 
        `;

        // STEP 3: Send the final built prompt to your AI
        // ---------------------------------------------------------
        // PASTE YOUR EXISTING LLM CALL HERE:
        // const aiResponse = await yourLLM.generate(finalPrompt);
        // ---------------------------------------------------------

        let finalAIAnswer = "<h1>Test Answer</h1><p>This is a test.</p>"; // Replace with your actual LLM response variable

        res.status(200).json({ answer: finalAIAnswer });

    } catch (error) {
        console.error("Chat route error:", error);
        res.status(500).json({ error: "Failed to generate AI response." });
    }
});

// --- Start the Server ---
app.listen(port, () => {
    console.log(`🚀 RAG Server is running on port ${port}`);
});