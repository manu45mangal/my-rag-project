import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import "dotenv/config";

// Word Document Loader
import { DocxLoader } from "@langchain/community/document_loaders/fs/docx";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone } from "@pinecone-database/pinecone";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { GoogleGenerativeAIEmbeddings, ChatGoogleGenerativeAI } from "@langchain/google-genai";

const app = express();
app.use(cors());
app.use(express.json());

// Setup Multer for file uploads
const upload = multer({ dest: "uploads/" });
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 1. Get a list of all active namespaces
app.get('/api/namespaces', async (req, res) => {
    try {

          const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
    const pineconeIndex = pinecone.Index("my-pdf-index"); 
        // describeIndexStats() returns metadata about your Pinecone index, including namespaces
        const stats = await pineconeIndex.describeIndexStats();
        
        // Extract just the names into an array
        const activeNamespaces = Object.keys(stats.namespaces || {});
        
        res.status(200).json({ namespaces: activeNamespaces });
    } catch (error) {
        console.error("Error fetching namespaces:", error);
        res.status(500).json({ error: error.message });
    }
});

// 2. Delete an entire namespace
app.delete('/api/namespaces/:namespace', async (req, res) => {
    try {
          const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
    const pineconeIndex = pinecone.Index("my-pdf-index"); 
        const targetNamespace = req.params.namespace;
        
        // Tell Pinecone to delete everything inside this specific namespace
        await pineconeIndex.namespace(targetNamespace).deleteAll();
        
        res.status(200).json({ message: `Namespace "${targetNamespace}" successfully deleted.` });
    } catch (error) {
        console.error("Error deleting namespace:", error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// ROUTE 1: UPLOAD & VECTORIZE (WORD DOCX)
// ==========================================
app.post("/api/upload", upload.single("wordFile"), async (req, res) => {
  try {
    const file = req.file;
    const namespaceKey = req.body.namespace;

    if (!file || !namespaceKey) {
      return res.status(400).send("Missing file or namespace!");
    }

    console.log(`\n[UPLOAD] Processing Word Document: ${file.originalname}...`);

    // Extract text from the .docx file
    const loader = new DocxLoader(file.path);
    const docs = await loader.load();
    
    // Split the text into manageable chunks
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 500,
      chunkOverlap: 50,
    });
    
    const rawChunks = await splitter.splitDocuments(docs);
    
    // Clean up any hidden null bytes or weird spacing
    const chunks = rawChunks
      .map(chunk => {
         chunk.pageContent = chunk.pageContent.replace(/\x00/g, '').trim();
         return chunk;
      })
      .filter(chunk => chunk.pageContent.length > 10);

    if (chunks.length === 0) {
      fs.unlinkSync(file.path); 
      console.log("[UPLOAD] 🛑 ABORTED: No text found in this document!");
      return res.status(400).json({ error: "No readable text found!" });
    }

    console.log(`[UPLOAD] 📊 Analysis: Found ${chunks.length} clean chunks.`);

    const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
    const pineconeIndex = pinecone.Index("my-pdf-index"); 

    // ==========================================
    // DOWNGRADED TO UNIVERSALLY SUPPORTED MODEL
    // ==========================================
    const geminiEmbeddings = new GoogleGenerativeAIEmbeddings({
model: "gemini-embedding-001", // <-- THE NEW 2026 STANDARD,
      apiKey: process.env.GEMINI_API_KEY,
    });

    const batchSize = 10;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      console.log(`\n[UPLOAD] Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(chunks.length / batchSize)}...`);
      
      const texts = batch.map(chunk => chunk.pageContent);
      console.log(`[DEBUG] 🧠 Asking Gemini to embed ${texts.length} text chunks individually...`);

      const vectors = [];
      for (let k = 0; k < texts.length; k++) {
          try {
              const vec = await geminiEmbeddings.embedQuery(texts[k]);
              vectors.push(vec);
          } catch (err) {
              console.error(`🚨 [ERROR] Gemini rejected chunk ${k}:`, err.message);
              vectors.push([]); 
          }
      }
      
      console.log(`[DEBUG] 🧠 Gemini returned ${vectors.length} vectors.`);
      
      const records = [];
      
      // Package records securely for Pinecone
      for (let j = 0; j < batch.length; j++) {
         const vec = vectors[j];
         
         if (vec && vec.length > 0) {
             records.push({
                 id: `vec-${Date.now()}-${i + j}`, 
                 values: Array.from(vec),          
                 metadata: {
                     text: batch[j].pageContent,   
                     source: file.originalname
                 }
             });
         }
      }
      
      console.log(`[DEBUG] 📦 Packaged ${records.length} valid records. Sending to Pinecone...`);

      if (records.length === 0) {
          console.log("🚨 [ERROR] Records array is empty! Pinecone upload skipped.");
          continue;
      }

      await pineconeIndex.namespace(namespaceKey).upsert(records);
      console.log(`[UPLOAD] ✅ Batch ${Math.floor(i / batchSize) + 1} stored successfully!`);

      if (i + batchSize < chunks.length) await delay(3000); 
    }

    fs.unlinkSync(file.path);
    console.log("[UPLOAD] 🚀 SUCCESS! Word document vectorized and stored.");
    res.status(200).json({ message: "Document successfully vectorized and stored!" });

  } catch (error) {
    console.error("[UPLOAD] 🛑 FATAL ERROR:", error);
    res.status(500).json({ error: "Something went wrong during vectorisation. Check terminal." });
  }
});

// ==========================================
// ROUTE 2: CHAT WITH DOCUMENT
// ==========================================
app.post("/api/chat", async (req, res) => {
  try {
    const { question, namespace } = req.body;

    if (!question || !namespace) {
      return res.status(400).json({ error: "Missing question or namespace!" });
    }

    console.log(`\n[CHAT] Searching namespace: '${namespace}' for question: '${question}'`);

    const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
    const pineconeIndex = pinecone.Index("my-pdf-index");

    // ==========================================
    // DOWNGRADED TO UNIVERSALLY SUPPORTED MODEL
    // ==========================================
    const geminiEmbeddings = new GoogleGenerativeAIEmbeddings({
model: "gemini-embedding-001", // <-- Update this to the new model!
      apiKey: process.env.GEMINI_API_KEY,
    });

    const vectorStore = await PineconeStore.fromExistingIndex(geminiEmbeddings, {
      pineconeIndex: pineconeIndex,
      namespace: namespace,
    });

    const llm = new ChatGoogleGenerativeAI({
      model: "gemini-2.5-flash", 
      temperature: 0,
      apiKey: process.env.GEMINI_API_KEY,
    });

    const prompt = ChatPromptTemplate.fromTemplate(`
      You are a helpful expert. Answer the user's question using ONLY the provided context.
      If the answer is not in the context, say "I cannot find the answer in the provided document."
      
      Context: {context}
      
      Question: {question}
    `);

    const retriever = vectorStore.asRetriever(5);

    const chain = RunnableSequence.from([
      {
        context: async (inputQuestion) => {
          const docs = await retriever.invoke(inputQuestion);
          console.log(`[DEBUG] Pinecone found ${docs.length} matching chunks!`);
          return docs.map((doc) => doc.pageContent).join("\n\n");
        },
        question: (inputQuestion) => inputQuestion,
      },
      prompt, 
      llm,    
      new StringOutputParser(), 
    ]);

    const answer = await chain.invoke(question);
    
    console.log("[CHAT] ✅ Answer generated successfully.");
    res.json({ answer: answer });

  } catch (error) {
    console.error("[CHAT] Error:", error);
    res.status(500).json({ error: "Failed to generate an answer." });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.resolve("index.html"));
});

app.listen(3000, () => {
  console.log("🚀 Server running on http://localhost:3000");
  console.log("📝 MODE: WORD DOCUMENTS ONLY (.docx)");
});