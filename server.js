// ARQUIVO: backend/server.js (Substitua TODO o seu conteúdo por este)
const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const dotenv = require('dotenv');
const cors = require('cors');
const mysql = require('mysql2/promise');

// 1. CARREGAR VARIÁVEL DE AMBIENTE (SUA CHAVE)
// No Render, as variáveis são lidas automaticamente, mas mantemos para testes locais.
dotenv.config({ path: './.env' }); 

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// 2. CONFIGURAÇÃO DO BANCO DE DADOS
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
};

let pool; 
const TEST_USER_ID = 1; 

async function connectToDatabase() {
    try {
        pool = mysql.createPool(dbConfig);
        console.log("Conexão com o banco de dados MySQL estabelecida com sucesso.");
        
        // Garante que o usuário de teste exista
        await pool.query(
            "INSERT IGNORE INTO USUARIOS (usuario_id, nome, email) VALUES (?, 'Aluno Teste', 'aluno@app.com')", [TEST_USER_ID]
        );
        
    } catch (error) {
        console.error("ERRO CRÍTICO: Não foi possível conectar ao banco de dados.", error.message);
        console.error("Verifique se as 5 variáveis de ambiente no Render estão corretas.");
        process.exit(1);
    }
}
connectToDatabase(); 

// 3. VERIFICAÇÃO DE CHAVE E INICIALIZAÇÃO DA AI
if (!GEMINI_API_KEY) {
    console.error("ERRO CRÍTICO: A chave GEMINI_API_KEY não está definida nas variáveis de ambiente do Render.");
    process.exit(1);
}

const app = express();
// === CORREÇÃO CRÍTICA AQUI ===
// A porta é lida da variável de ambiente PORT (fornecida pelo Render)
const port = process.env.PORT || 3000;
// =============================

app.use(cors()); 
app.use(express.json()); 

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const model = "gemini-2.5-flash"; 

// --- 4. ENDPOINT PRINCIPAL: CORREÇÃO E SALVAMENTO NO BD
app.post('/api/corrigir-redacao', async (req, res) => {
    const { redacao, tema } = req.body;

    if (!redacao || redacao.length < 50) {
        return res.status(400).json({ error: "O texto da redação é muito curto." });
    }

    const prompt = `
        Você é um corretor de redações expert no modelo ENEM, atribuindo notas de 0 a 200 para cada uma das 5 competências.
        Analise o texto a seguir e gere uma resposta estritamente no formato JSON.
        
        Texto da Redação:
        """${redacao}"""
        
        O JSON DEVE CONTER:
        1. nota_final (soma das 5 competências, 0 a 1000)
        2. c1_score (nota da Competência 1: Domínio da norma padrão)
        3. c2_score (nota da Competência 2: Compreensão da proposta)
        4. c3_score (nota da Competência 3: Seleção e organização de informações)
        5. c4_score (nota da Competência 4: Demonstração de conhecimento e coesão)
        6. c5_score (nota da Competência 5: Elaboração de proposta de intervenção)
        7. feedback_detalhado (uma análise completa e construtiva, focando nos pontos fracos e fortes de cada competência, usando quebras de linha \\n).
    `;

    try {
        const response = await ai.models.generateContent({
            model: model,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "object",
                    properties: {
                        nota_final: { type: "integer" },
                        c1_score: { type: "integer" },
                        c2_score: { type: "integer" },
                        c3_score: { type: "integer" },
                        c4_score: { type: "integer" },
                        c5_score: { type: "integer" },
                        feedback_detalhado: { type: "string" }
                    },
                    required: ["nota_final", "c1_score", "c2_score", "c3_score", "c4_score", "c5_score", "feedback_detalhado"]
                }
            }
        });

        const correção = JSON.parse(response.text);

        // ** SALVAR NO BANCO DE DADOS **
        const query = `
            INSERT INTO REDACOES 
            (usuario_id, tema, texto_original, nota_final, c1_score, c2_score, c3_score, c4_score, c5_score, feedback_detalhado) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const values = [
            TEST_USER_ID,
            tema || 'Tema: Redação Corrigida', 
            redacao,
            correção.nota_final,
            correção.c1_score,
            correção.c2_score,
            correção.c3_score,
            correção.c4_score,
            correção.c5_score,
            correção.feedback_detalhado
        ];

        try {
            await pool.query(query, values);
            console.log(`Redação salva com sucesso. Nota: ${correção.nota_final}`);
        } catch (dbError) {
            console.error("Erro ao salvar correção no banco de dados:", dbError);
        }
        
        res.json(correção);

    } catch (error) {
        console.error("Erro ao processar a correção pela IA:", error.message);
        res.status(500).json({ error: "Erro ao processar a correção.", details: error.message });
    }
});

// --- 5. ENDPOINT PARA SALVAR RASCUNHO
app.post('/api/salvar-rascunho', async function(req, res) {
    const { redacao } = req.body;
    const userId = TEST_USER_ID; 

    if (!redacao || redacao.trim() === '') {
        return res.status(400).json({ success: false, error: "O rascunho está vazio." });
    }

    // Salva o rascunho com nota_final = 0 para distinguir das correções
    const query = `
        INSERT INTO REDACOES 
        (usuario_id, tema, texto_original, nota_final, c1_score, c2_score, c3_score, c4_score, c5_score, feedback_detalhado) 
        VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 'Rascunho salvo. Aguardando correção.')
    `;
    const values = [
        userId,
        'Rascunho Salvo', 
        redacao,
    ];

    try {
        await pool.query(query, values);
        res.json({ success: true, message: "Rascunho salvo com sucesso." });
    } catch (dbError) {
        console.error("Erro ao salvar rascunho no banco de dados:", dbError);
        res.status(500).json({ success: false, error: "Erro interno ao salvar rascunho." });
    }
});


// --- 6. ENDPOINT DE DADOS DO DASHBOARD 
app.get('/api/dashboard-data/:usuario_id', async function(req, res) {
    const userId = TEST_USER_ID; 

    try {
        // Query 1: Sumário e Médias
        const [sumarioRows] = await pool.query(`
            SELECT 
                COUNT(*) AS total_redacoes,
                IFNULL(AVG(nota_final), 0) AS nota_media,
                IFNULL(AVG(c1_score), 0) AS c1_media,
                IFNULL(AVG(c2_score), 0) AS c2_media,
                IFNULL(AVG(c3_score), 0) AS c3_media,
                IFNULL(AVG(c4_score), 0) AS c4_media,
                IFNULL(AVG(c5_score), 0) AS c5_media
            FROM REDACOES WHERE usuario_id = ? AND nota_final > 0
        `, [userId]);

        // Query 2: Histórico de Redações Corrigidas (Notas > 0)
        const [historicoRows] = await pool.query(`
            SELECT 
                redacao_id, tema, nota_final, DATE_FORMAT(data_submissao, '%d/%m/%Y') AS data
            FROM REDACOES WHERE usuario_id = ? AND nota_final > 0
            ORDER BY data_submissao DESC
        `, [userId]);

        // Query 3: Rascunhos (Nota = 0)
        const [rascunhoRows] = await pool.query(`
            SELECT 
                redacao_id, LEFT(texto_original, 100) AS texto_preview, DATE_FORMAT(data_submissao, '%d/%m/%Y %H:%i') AS data
            FROM REDACOES WHERE usuario_id = ? AND nota_final = 0
            ORDER BY data_submissao DESC
        `, [userId]);


        const sumario = sumarioRows[0];

        res.json({
            sumario: {
                redacoesCorrigidas: parseInt(sumario.total_redacoes),
                notaMedia: Math.round(sumario.nota_media),
                mediaC1: Math.round(sumario.c1_media),
                mediaC2: Math.round(sumario.c2_media),
                mediaC3: Math.round(sumario.c3_media),
                mediaC4: Math.round(sumario.c4_media),
                mediaC5: Math.round(sumario.c5_media)
            },
            historico: historicoRows.map(row => ({
                id: row.redacao_id,
                tema: row.tema,
                nota: row.nota_final,
                data: row.data
            })),
            rascunhos: rascunhoRows.map(row => ({
                id: row.redacao_id,
                texto: row.texto_preview + '...', 
                data: row.data
            }))
        });

    } catch (error) {
        console.error("Erro ao buscar dados do dashboard:", error);
        res.status(500).json({ error: "Erro ao carregar dados do dashboard." });
    }
});

// --- 7. ENDPOINT PARA BUSCAR REDAÇÃO/RASCUNHO POR ID (NOVO/CRUCIAL PARA O MODAL)
app.get('/api/redacao/:id', async function(req, res) {
    const redacaoId = req.params.id;

    try {
        const [rows] = await pool.query(
            "SELECT redacao_id, tema, texto_original, nota_final, c1_score, c2_score, c3_score, c4_score, c5_score, feedback_detalhado FROM REDACOES WHERE redacao_id = ?",
            [redacaoId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Redação ou rascunho não encontrado." });
        }

        res.json(rows[0]);

    } catch (error) {
        console.error("Erro ao buscar redação por ID:", error);
        res.status(500).json({ error: "Erro interno ao buscar a redação." });
    }
});


// 8. INICIAR O SERVIDOR
app.listen(port, function() {
    console.log(`Servidor de correção rodando na porta ${port}`);
    console.log(`Endpoint de correção: /api/corrigir-redacao`);
});