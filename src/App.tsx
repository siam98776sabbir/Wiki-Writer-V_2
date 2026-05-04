import { useState, useRef } from "react";
import {
  Languages,
  Search,
  Copy,
  Check,
  Loader2,
  ExternalLink,
  Info,
  AlertCircle,
  BookOpen,
  FileText,
  PenTool,
  ArrowRight,
  Sparkles,
  RefreshCw
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { GoogleGenAI } from "@google/genai";
import { INSTRUCTIONS } from "./constants";

interface ChunkStats {
  sourceImages: number;
  resultImages: number;
  sourceWords: number;
  resultWords: number;
}

interface Chunk {
  id: string;
  source: string;
  result: string;
  isTranslating: boolean;
  error: string | null;
  stats: ChunkStats | null;
}

export default function App() {
  const [input, setInput] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedChunkId, setCopiedChunkId] = useState<string | null>(null);

  const handleFetch = async () => {
    if (!input.trim()) return;
    setIsFetching(true);
    setError(null);
    setChunks([]);

    try {
      let title = input.trim();
      let wikiHost = "en.wikipedia.org";

      // Parse URL if provided
      if (title.includes("wikipedia.org") || title.includes("wikibooks.org")) {
        try {
          const url = new URL(title);
          wikiHost = url.hostname;
          const searchParams = new URLSearchParams(url.search);
          if (searchParams.has("title")) {
            title = searchParams.get("title") || "";
          } else if (url.pathname.startsWith("/wiki/")) {
            title = decodeURIComponent(url.pathname.substring(6));
          }
        } catch (e) {
          // Fallback to plain title if URL parsing fails
        }
      }

      const apiUrl = `https://${wikiHost}/w/api.php?action=query&prop=revisions&titles=${encodeURIComponent(title)}&rvprop=content&rvslots=main&format=json&origin=*&redirects=1`;
      
      const response = await fetch(apiUrl);
      if (!response.ok) {
        throw new Error(`Wikipedia API error: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      if (!data.query || !data.query.pages) {
        throw new Error("Invalid API response from Wikipedia.");
      }
      
      const pages = data.query.pages;
      const pageId = Object.keys(pages)[0];
      
      if (pageId === "-1") {
        throw new Error(`Article "${title}" not found on ${wikiHost}.`);
      }

      const revision = pages[pageId].revisions?.[0];
      let content = "";

      if (revision) {
        if (revision.slots?.main?.["*"]) {
          content = revision.slots.main["*"];
        } else if (revision["*"]) {
          content = revision["*"];
        } else if (revision.content) {
          content = revision.content;
        }
      }

      if (!content) {
        throw new Error("Could not retrieve article content. The page might be empty or restricted.");
      }

      // Chunk wikitext: ~2500 chars at paragraph boundaries
      const rawChunks = content.split(/\n\n+/);
      const optimizedChunks: string[] = [];
      let currentChunk = "";

      for (const part of rawChunks) {
        if ((currentChunk.length + part.length) > 3000 && currentChunk.length > 0) {
          optimizedChunks.push(currentChunk);
          currentChunk = part;
        } else {
          currentChunk = currentChunk ? `${currentChunk}\n\n${part}` : part;
        }
      }
      if (currentChunk) optimizedChunks.push(currentChunk);

      setChunks(optimizedChunks.map((c, i) => ({
        id: `chunk-${i}`,
        source: c,
        result: "",
        isTranslating: false,
        error: null,
        stats: null
      })));

    } catch (err) {
      setError(err instanceof Error ? err.message : "An unknown error occurred while fetching.");
    } finally {
      setIsFetching(false);
    }
  };

  const translateChunk = async (chunkId: string) => {
    const chunk = chunks.find(c => c.id === chunkId);
    if (!chunk || chunk.isTranslating) return;

    const apiKey = (process.env.GEMINI_API_KEY as string) || ((import.meta as any).env.VITE_GEMINI_API_KEY as string);
    if (!apiKey || apiKey === "MY_GEMINI_API_KEY" || apiKey === "undefined") {
      setChunks(prev => prev.map(c => c.id === chunkId ? { ...c, error: "Gemini API key is missing. Please ensure VITE_GEMINI_API_KEY is set." } : c));
      return;
    }

    setChunks(prev => prev.map(c => c.id === chunkId ? { ...c, isTranslating: true, error: null } : c));

    try {
    const apiKeyVal = (process.env.GEMINI_API_KEY as string) || ((import.meta as any).env.VITE_GEMINI_API_KEY as string);
    const ai = new GoogleGenAI({ apiKey: apiKeyVal });

      // Count images in source
      const imageMatches = chunk.source.match(/\[\[(File|Image):/gi) || [];
      const templateImageMatches = chunk.source.match(/\|\s*(image|logo|photo|map|flag)\s*=\s*[^|\n]+/gi) || [];
      const totalSourceImages = imageMatches.length + templateImageMatches.length;

      const result = await ai.models.generateContentStream({
        model: "gemini-2.0-flash",
        contents: `TRANSLATE THIS WIKITEXT SECTION.
- MANDATORY: YOU MUST PRESERVE ALL ${totalSourceImages} IMAGES (Every [[File:...]], [[Image:...]], and image template param).
- MANDATORY: KEEP ALL WIKITEXT SYMBOLS (brackets, pipes, templates, tags) CHARACTER-FOR-CHARACTER.
- MANDATORY: TRANSLATE ONLY THE HUMAN-READABLE TEXT WITHIN THE WIKITEXT.
- MANDATORY: USE FLOWING, NATURAL BENGALI. DO NOT BE COPIES OF ENGLISH STRUCTURE.
- MANDATORY: EXPAND THE CONTENT AS PER THE 1.2X RULE.

SOURCE WIKITEXT:
${chunk.source}`,
        config: {
          systemInstruction: INSTRUCTIONS,
          temperature: 0.1,
        }
      });

      let responseText = "";
      for await (const chunkResponse of result) {
        const partText = chunkResponse.text || "";
        responseText += partText;
        
        // Periodic state updates for smooth appearing text
        setChunks(prev => prev.map(c => c.id === chunkId ? {
          ...c,
          result: responseText.replace(/^```wikitext\n?|```$/g, "").trim(),
        } : c));
      }

      const finalResponseText = responseText.replace(/^```wikitext\n?|```$/g, "").trim();
      
      if (!finalResponseText) {
        throw new Error("Empty response from AI. Please try again.");
      }
      
      // Calculate stats
      const resultImageMatches = finalResponseText.match(/\[\[(File|Image):/gi) || [];
      const resultTemplateImageMatches = finalResponseText.match(/\|\s*(image|logo|photo|map|flag)\s*=\s*[^|\n]+/gi) || [];
      const totalResultImages = resultImageMatches.length + resultTemplateImageMatches.length;

      const sourceWords = chunk.source.trim().split(/\s+/).length;
      const resultWords = finalResponseText.trim().split(/\s+/).length;

      setChunks(prev => prev.map(c => c.id === chunkId ? {
        ...c,
        result: finalResponseText,
        isTranslating: false,
        stats: {
          sourceImages: totalSourceImages,
          resultImages: totalResultImages,
          sourceWords,
          resultWords
        }
      } : c));

    } catch (err: any) {
      console.error("Gemini API Error Detail:", err);
      const errorMessage = err?.message || (typeof err === "string" ? err : "Translation fail.");
      setChunks(prev => prev.map(c => c.id === chunkId ? {
        ...c,
        isTranslating: false,
        error: `API Error: ${errorMessage}`
      } : c));
    }
  };

  const copyToClipboard = async (text: string, id?: string) => {
    try {
      await navigator.clipboard.writeText(text);
      if (id) {
        setCopiedChunkId(id);
        setTimeout(() => setCopiedChunkId(null), 2000);
      } else {
        setCopiedAll(true);
        setTimeout(() => setCopiedAll(false), 2000);
      }
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const completedChunks = chunks.filter(c => c.result).length;
  const progressPercent = chunks.length > 0 ? (completedChunks / chunks.length) * 100 : 0;

  return (
    <div className="min-h-screen bg-neutral-50 flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white border-b border-neutral-200 px-4 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-emerald-200">
              <Languages className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-neutral-900 leading-none">Bengali Wiki Writer</h1>
              <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest mt-1">Multi-Wiki Editor Pro</p>
            </div>
          </div>
          <a
            href="https://bn.wikipedia.org"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600 hover:text-emerald-700 transition-colors bg-emerald-50 px-3 py-2 rounded-lg"
          >
            Bengali Wikipedia <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </header>

      <main className="flex-grow max-w-7xl mx-auto w-full p-4 lg:p-8 space-y-8">
        {/* Search Bar */}
        <div className="max-w-3xl mx-auto flex flex-col gap-3">
          <div className="relative group">
            <div className="absolute inset-0 bg-emerald-500/10 blur-xl group-hover:bg-emerald-500/20 transition-all rounded-3xl" />
            <div className="relative flex bg-white rounded-2xl border border-neutral-200 shadow-sm p-1.5 focus-within:ring-2 focus-within:ring-emerald-500/20 focus-within:border-emerald-500 transition-all">
              <div className="flex items-center pl-3 text-neutral-400">
                <Search className="w-5 h-5" />
              </div>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleFetch()}
                placeholder="Enter Wikipedia, Wikibooks title or URL..."
                className="flex-grow bg-transparent border-none focus:ring-0 text-base py-3 px-4 placeholder:text-neutral-400 outline-none"
              />
              <button
                onClick={handleFetch}
                disabled={isFetching || !input.trim()}
                className="bg-neutral-900 hover:bg-neutral-800 disabled:bg-neutral-300 text-white font-semibold px-6 py-3 rounded-xl transition-all flex items-center gap-2 active:scale-95 shrink-0"
              >
                {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                Fetch Article
              </button>
            </div>
          </div>
          <p className="text-center text-xs text-neutral-500">
            Example: <span className="font-mono text-neutral-700">"Black hole"</span> or <span className="font-mono text-neutral-700">"https://en.wikibooks.org/wiki/Chess"</span>
          </p>
        </div>

        {/* Error Banner */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="bg-red-50 border border-red-100 p-4 rounded-xl flex items-center gap-3 text-red-600 text-sm max-w-3xl mx-auto"
            >
              <AlertCircle className="w-5 h-5 shrink-0" />
              <p>{error}</p>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="grid lg:grid-cols-12 gap-8 items-start">
          {/* Sidebar */}
          <div className="lg:col-span-3 space-y-6 hidden lg:block">
            <div className="bg-white rounded-2xl border border-neutral-200 p-6 space-y-6">
              <h3 className="font-bold text-sm text-neutral-900 flex items-center gap-2">
                <Info className="w-4 h-4 text-emerald-600" />
                Quick Guide
              </h3>
              <div className="space-y-4">
                {[
                  "Fetch any English Wikipedia, Wikibooks or Wiki article.",
                  "Generate a publication-ready Bengali version section-by-section.",
                  "Copy and paste into Bengali Wikipedia source editor."
                ].map((step, i) => (
                  <div key={i} className="flex gap-3">
                    <div className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                      {i + 1}
                    </div>
                    <p className="text-xs leading-relaxed text-neutral-600">{step}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-emerald-900 rounded-2xl p-6 text-white relative overflow-hidden group">
              <div className="relative z-10 space-y-3">
                <div className="flex items-center gap-2 text-emerald-300">
                  <PenTool className="w-4 h-4" />
                  <span className="text-[10px] uppercase font-black tracking-widest">Efficiency Engine</span>
                </div>
                <h4 className="font-bold text-lg leading-tight">Journalistic Quality</h4>
                <p className="text-xs text-emerald-100/80 leading-relaxed">
                  Our algorithm ensures natural connectors, active voice, and living vocabulary instead of robotic literal translations.
                </p>
              </div>
              <BookOpen className="absolute -right-4 -bottom-4 w-32 h-32 text-emerald-800 opacity-20 transform -rotate-12 group-hover:scale-110 transition-transform duration-500" />
            </div>

            {chunks.length > 0 && (
              <div className="bg-white rounded-2xl border border-neutral-200 p-6 space-y-4">
                <div className="flex justify-between items-end">
                  <span className="text-xs font-bold text-neutral-500 uppercase tracking-tight">Overall Progress</span>
                  <span className="text-sm font-black text-emerald-600">{completedChunks} / {chunks.length}</span>
                </div>
                <div className="h-2 w-full bg-neutral-100 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-emerald-500"
                    initial={{ width: 0 }}
                    animate={{ width: `${progressPercent}%` }}
                    transition={{ duration: 1, ease: "easeOut" }}
                  />
                </div>
                <p className="text-[10px] text-neutral-400 text-center italic">
                  Complete all sections for a perfect article
                </p>
              </div>
            )}
          </div>

          {/* Main Content Area */}
          <div className="lg:col-span-9 space-y-6">
            {chunks.length === 0 ? (
              <div className="bg-white rounded-3xl border border-neutral-200 border-dashed p-12 lg:p-24 flex flex-col items-center text-center space-y-6">
                <div className="w-20 h-20 bg-neutral-100 rounded-full flex items-center justify-center text-neutral-400">
                  <BookOpen className="w-10 h-10" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-2xl font-bold text-neutral-900">Ready to start?</h2>
                  <p className="text-neutral-500 max-w-sm">
                    Enter an article title or full URL above to fetch wikitext and begin your translation masterwork.
                  </p>
                </div>
                <div className="grid sm:grid-cols-2 gap-4 w-full max-w-lg pt-8">
                  <div className="bg-emerald-50 border border-emerald-100 p-6 rounded-2xl space-y-2 text-left">
                    <div className="w-8 h-8 bg-emerald-600 rounded-lg flex items-center justify-center text-white mb-2">
                      <PenTool className="w-4 h-4" />
                    </div>
                    <h4 className="font-bold text-emerald-900 text-sm">Edit First</h4>
                    <p className="text-xs text-emerald-700/80">Refine English source before starting translation.</p>
                  </div>
                  <div className="bg-amber-50 border border-amber-100 p-6 rounded-2xl space-y-2 text-left">
                    <div className="w-8 h-8 bg-amber-600 rounded-lg flex items-center justify-center text-white mb-2">
                      <RefreshCw className="w-4 h-4" />
                    </div>
                    <h4 className="font-bold text-amber-900 text-sm">Rewrite</h4>
                    <p className="text-xs text-amber-700/80">Each section gets a dedicated high-temp AI pass.</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="sticky top-20 z-40 bg-neutral-50/80 backdrop-blur-md py-2 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-bold text-neutral-900">Article Sections ({chunks.length})</h2>
                    <p className="text-xs text-neutral-500">Translate parts individually for total accuracy</p>
                  </div>
                  <button
                    onClick={() => copyToClipboard(chunks.map(c => c.result || "").filter(Boolean).join("\n\n"))}
                    disabled={completedChunks === 0}
                    className="flex items-center gap-2 bg-neutral-900 hover:bg-neutral-800 disabled:bg-neutral-300 text-white px-5 py-2.5 rounded-xl text-sm font-bold shadow-lg shadow-neutral-200 transition-all active:scale-95 cursor-pointer disabled:cursor-not-allowed"
                  >
                    {copiedAll ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    {copiedAll ? "Copied All Translated!" : "Copy All Translated Sections"}
                  </button>
                </div>

                <div className="space-y-8 pb-20">
                  {chunks.map((chunk, index) => (
                    <motion.div
                      key={chunk.id}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="group"
                    >
                      <div className="bg-white rounded-2xl border border-neutral-200 shadow-sm overflow-hidden transition-all group-hover:shadow-md group-hover:border-neutral-300">
                        {/* Chunk Header */}
                        <div className="px-5 py-3 border-b border-neutral-100 bg-neutral-50 flex items-center justify-between">
                          <div className="flex items-center gap-4">
                            <div className="bg-neutral-900 text-white text-[10px] font-black w-7 h-7 flex items-center justify-center rounded-lg">
                              #{index + 1}
                            </div>
                            <div>
                              <p className="text-xs font-bold text-neutral-700">Section {index + 1}</p>
                              <p className="text-[10px] text-neutral-400 font-mono italic">{chunk.source.length} characters</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            {chunk.error && (
                              <div className="hidden sm:flex items-center gap-1.5 text-red-500 text-[10px] font-black uppercase">
                                <AlertCircle className="w-3 h-3" />
                                {chunk.error.substring(0, 30)}...
                              </div>
                            )}
                            <button
                              onClick={() => translateChunk(chunk.id)}
                              disabled={chunk.isTranslating}
                              className={`flex items-center gap-2 sm:px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-all active:scale-95 ${
                                chunk.result 
                                  ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200" 
                                  : "bg-emerald-600 text-white hover:bg-emerald-700 shadow-md shadow-emerald-200"
                              } disabled:grayscale`}
                            >
                              {chunk.isTranslating ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Languages className="w-3 h-3" />
                              )}
                              {chunk.result ? "Re-translate Section" : "Translate to Bengali"}
                            </button>
                          </div>
                        </div>

                        {/* Translation Areas */}
                        <div className="grid lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-neutral-100">
                          {/* Source Editor */}
                          <div className="flex flex-col bg-neutral-900">
                            <div className="bg-neutral-800/80 px-4 py-2 flex items-center justify-between">
                              <div className="flex items-center gap-2 text-neutral-400 text-[10px] font-bold uppercase tracking-widest">
                                <PenTool className="w-3 h-3" /> Editorial Zone (English)
                              </div>
                            </div>
                            <div
                              contentEditable
                              suppressContentEditableWarning
                              onBlur={(e) => {
                                const newText = e.currentTarget.innerText;
                                setChunks(prev => prev.map(c => c.id === chunk.id ? { ...c, source: newText } : c));
                              }}
                              className="w-full h-80 p-6 font-mono text-[13px] leading-relaxed text-neutral-300 focus:outline-none overflow-y-auto spellcheck-false whitespace-pre-wrap selection:bg-emerald-500/30"
                              dangerouslySetInnerHTML={{ __html: chunk.source }}
                            />
                          </div>

                          {/* Result Viewer */}
                          <div className="flex flex-col bg-emerald-950/30">
                            <div className="bg-emerald-900/40 px-4 py-2 flex items-center justify-between">
                              <div className="flex items-center gap-2 text-emerald-200 text-[10px] font-bold uppercase tracking-widest">
                                <FileText className="w-3 h-3" /> Bengali Result
                              </div>
                              {chunk.result && (
                                <button
                                  onClick={() => copyToClipboard(chunk.result, chunk.id)}
                                  className="text-emerald-400 hover:text-emerald-300 flex items-center gap-1.5 transition-colors"
                                >
                                  {copiedChunkId === chunk.id ? (
                                    <span className="flex items-center gap-1 text-[10px] font-bold">
                                      <Check className="w-3 h-3" /> COPIED
                                    </span>
                                  ) : (
                                    <span className="flex items-center gap-1 text-[10px] font-bold">
                                      <Copy className="w-3 h-3" /> COPY SECTION
                                    </span>
                                  )}
                                </button>
                              )}
                            </div>
                            <div className="flex-grow flex flex-col items-center justify-center p-6 relative h-80">
                              {chunk.isTranslating ? (
                                <div className="space-y-4 text-center">
                                  <Loader2 className="w-10 h-10 animate-spin text-emerald-500 mx-auto" />
                                  <p className="text-xs font-bold text-emerald-400 animate-pulse tracking-widest uppercase">Rewriting Knowledge...</p>
                                </div>
                              ) : chunk.result ? (
                                <textarea
                                  readOnly
                                  value={chunk.result}
                                  className="w-full h-full bg-transparent border-none focus:ring-0 p-0 font-mono text-[13px] leading-relaxed text-emerald-50 resize-none overflow-y-auto selection:bg-white/20"
                                />
                              ) : (
                                <div className="text-neutral-400 flex flex-col items-center gap-4 py-12">
                                  <Languages className="w-12 h-12 opacity-10" />
                                  <p className="text-[10px] font-bold uppercase tracking-widest opacity-40">Ready to Translate</p>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Stats Bar */}
                        {chunk.stats && (
                          <div className="bg-white border-t border-neutral-100 grid grid-cols-2 divide-x divide-neutral-100">
                            <div className="px-5 py-3 flex items-center justify-between">
                              <span className="text-[10px] font-bold text-neutral-400 uppercase">Images Preserved</span>
                              <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-[10px] font-black ${
                                chunk.stats.resultImages === chunk.stats.sourceImages 
                                  ? "bg-emerald-50 text-emerald-600" 
                                  : "bg-red-50 text-red-600"
                              }`}>
                                {chunk.stats.resultImages} / {chunk.stats.sourceImages}
                                {chunk.stats.resultImages === chunk.stats.sourceImages ? <Check className="w-2.5 h-2.5" /> : <AlertCircle className="w-2.5 h-2.5" />}
                              </div>
                            </div>
                            <div className="px-5 py-3 flex items-center justify-between">
                              <span className="text-[10px] font-bold text-neutral-400 uppercase">Article Expansion</span>
                              <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-[10px] font-black ${
                                (chunk.stats.resultWords / chunk.stats.sourceWords) >= 1.2
                                  ? "bg-emerald-50 text-emerald-600"
                                  : "bg-amber-50 text-amber-600"
                              }`}>
                                {(chunk.stats.resultWords / chunk.stats.sourceWords).toFixed(1)}x
                                {(chunk.stats.resultWords / chunk.stats.sourceWords) >= 1.2 ? <Sparkles className="w-2.5 h-2.5" /> : <Info className="w-2.5 h-2.5" />}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-neutral-200 px-4 py-8 mt-auto">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3 opacity-50">
            <Languages className="w-5 h-5 text-emerald-600" />
            <h2 className="text-sm font-bold text-neutral-900">Bengali Wiki Writer</h2>
          </div>
          <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest text-center">
            Developer Info — Sabbir Ahamed Siam || CE, CUET
          </p>
          <div className="flex items-center gap-6 text-xs font-semibold text-neutral-400">
            <span className="cursor-not-allowed">Privacy</span>
            <span className="cursor-not-allowed">Terms</span>
            <span className="cursor-not-allowed">Help</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
