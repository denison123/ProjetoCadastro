const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();

// Middlewares básicos
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve os arquivos do frontend na pasta public

// Configuração da pasta de Uploads para os Termos
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configuração do Multer (Armazenamento de PDFs/Imagens)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'termo-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Servir os arquivos enviados publicamente
app.use('/uploads', express.static(uploadDir));

// Configuração de conexão com o PostgreSQL
const pool = new Pool({
  host: '10.64.10.100',      // Seu IP
  user: 'postgres',           // Seu usuário
  password: '123456*p',      // Sua senha
  database: 'postgres',       // Nome da Database real
  port: 5432,                 // Sua porta[cite: 19]
  options: '-c search_path="Inventario",public' // Adicionadas aspas duplas no schema
});

// ==========================================
// ROTAS DE DEPARTAMENTOS E CATEGORIAS
// ==========================================

// GET: Departamentos
app.get('/api/departamentos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM departamentos ORDER BY nome ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET: Categorias
app.get('/api/categorias', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM categorias ORDER BY nome ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ROTAS DE USUÁRIOS
// ==========================================

// GET: Listar Usuários (Ordenados por nome de A a Z)
app.get('/api/usuarios', async (req, res) => {
  try {
    const query = `
      SELECT u.id, u.nome, u.email, u.cargo, u.matricula, u.status, u.localidade,
             u.departamento_id, d.nome AS departamento_nome
      FROM usuarios u
      LEFT JOIN departamentos d ON u.departamento_id = d.id
      ORDER BY u.nome ASC;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST: Cadastrar Usuário
app.post('/api/usuarios', async (req, res) => {
  try {
    const { nome, email, cargo, matricula, departamento_id, localidade, status } = req.body;

    const query = `
      INSERT INTO usuarios (nome, email, cargo, matricula, departamento_id, localidade, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *;
    `;
    const values = [nome, email, cargo, matricula, departamento_id, localidade, status || 'Ativo'];
    const result = await pool.query(query, values);

    res.json({ success: true, usuario: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ROTAS DE EQUIPAMENTOS
// ==========================================
app.get('/api/equipamentos', async (req, res) => {
  try {
    const query = `
            SELECT 
                e.id,
                e.numero_patrimonio,
                e.numero_serie,
                e.marca,
                e.modelo,
                e.especificacoes,
                e.perifericos,
                e.status,
                e.termo_url,
                e.categoria_id,
                c.nome AS categoria_nome,
                COALESCE(
                    (
                        SELECT array_to_string(array_agg(u.nome), ', ')
                        FROM equipamento_usuarios eu
                        JOIN usuarios u ON u.id = eu.usuario_id
                        WHERE eu.equipamento_id = e.id
                    ),
                    'Em Estoque'
                ) AS usuario_nome
            FROM equipamentos e
            LEFT JOIN categorias c ON e.categoria_id = c.id
            ORDER BY e.id DESC;
        `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Erro na rota GET /api/equipamentos:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST: Cadastrar Equipamento com Suporte a Múltiplos Usuários

app.post('/api/equipamentos', upload.single('termo_pdf'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      numero_patrimonio, numero_serie, categoria_id, marca,
      modelo, imei_1, imei_2, especificacoes, perifericos, status, usuarios_ids
    } = req.body;

    const termo_url = req.file ? `/uploads/${req.file.filename}` : null;
    const listaUsuarios = Array.isArray(usuarios_ids)
      ? usuarios_ids
      : (usuarios_ids ? JSON.parse(usuarios_ids) : []);

    // Insere o equipamento
    const insertEq = `
      INSERT INTO equipamentos 
      (numero_patrimonio, numero_serie, categoria_id, marca, modelo, imei_1, imei_2, especificacoes, perifericos, status, termo_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id;
    `;
    const result = await client.query(insertEq, [
      numero_patrimonio, numero_serie, categoria_id ? parseInt(categoria_id) : null,
      marca, modelo, imei_1 || null, imei_2 || null, especificacoes || null,
      perifericos || null, status, termo_url
    ]);

    const porTipo = await pool.query(`
  SELECT COALESCE(c.nome, 'Sem Categoria') AS tipo, COUNT(e.id) AS quantidade
  FROM equipamentos e
  LEFT JOIN categorias c ON e.categoria_id = c.id
  GROUP BY c.nome
`);

    const equipamentoId = result.rows[0].id;

    // Vincula todos os jovens aprendizes selecionados
    if (listaUsuarios.length > 0 && status === 'Em Uso') {
      for (const usrId of listaUsuarios) {
        await client.query(
          'INSERT INTO equipamento_usuarios (equipamento_id, usuario_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [equipamentoId, parseInt(usrId)]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao salvar equipamento:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});
// ==========================================
// ROTA DO DASHBOARD / ESTATÍSTICAS
// ==========================================

// --- ROTA DE ESTATÍSTICAS DO DASHBOARD (ATUALIZADA) ---
app.get('/api/dashboard/estatisticas', async (req, res) => {
  try {
    const totalEq = await pool.query('SELECT COUNT(*) FROM equipamentos');
    const eqEmUso = await pool.query("SELECT COUNT(*) FROM equipamentos WHERE status = 'Em Uso'");
    const eqEstoque = await pool.query("SELECT COUNT(*) FROM equipamentos WHERE status IN ('Backup', 'Estoque')");
    const totalUsr = await pool.query('SELECT COUNT(*) FROM usuarios');

    // Novas estatísticas de Telefonia
    const totalLinhas = await pool.query('SELECT COUNT(*) FROM linhas_telefonicas');
    const linhasEmUso = await pool.query("SELECT COUNT(*) FROM linhas_telefonicas WHERE status = 'Em Uso'");

    // Estatísticas de Smartphones/Celulares
    const totalSmartphones = await pool.query(`
      SELECT COUNT(*) FROM equipamentos e
      JOIN categorias c ON e.categoria_id = c.id
      WHERE LOWER(c.nome) LIKE '%smartphone%' OR LOWER(c.nome) LIKE '%celular%' OR LOWER(c.nome) LIKE '%telefone%'
    `);

    const porTipo = await pool.query(`
      SELECT c.nome AS tipo, COUNT(e.id) AS quantidade
      FROM equipamentos e
      LEFT JOIN categorias c ON e.categoria_id = c.id
      GROUP BY c.nome
    `);

    res.json({
      totalEquipamentos: parseInt(totalEq.rows[0].count),
      equipamentosEmUso: parseInt(eqEmUso.rows[0].count),
      equipamentosEmEstoque: parseInt(eqEstoque.rows[0].count),
      totalUsuarios: parseInt(totalUsr.rows[0].count),
      totalLinhas: parseInt(totalLinhas.rows[0].count),
      linhasEmUso: parseInt(linhasEmUso.rows[0].count),
      totalSmartphones: parseInt(totalSmartphones.rows[0].count),
      porTipo: porTipo.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ROTA DO RELATÓRIO DE AUDITORIA COMPILADO POR USUÁRIO ---
app.get('/api/relatorio/auditoria', async (req, res) => {
  try {
    const query = `
      SELECT 
        u.id AS usuario_id,
        u.nome AS usuario_nome,
        u.matricula,
        d.nome AS departamento,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object(
            'id', e.id,
            'patrimonio', e.numero_patrimonio,
            'modelo', e.modelo,
            'imei_1', e.imei_1,
            'termo_url', e.termo_url
          )) FILTER (WHERE e.id IS NOT NULL), '[]'
        ) AS equipamentos,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object(
            'id', l.id,
            'numero', l.numero_linha,
            'operadora', l.operadora,
            'termo_url', l.termo_url
          )) FILTER (WHERE l.id IS NOT NULL), '[]'
        ) AS linhas
      FROM usuarios u
      LEFT JOIN departamentos d ON u.departamento_id = d.id
      LEFT JOIN equipamento_usuarios eu ON eu.usuario_id = u.id
      LEFT JOIN equipamentos e ON e.id = eu.equipamento_id
      LEFT JOIN linhas_telefonicas l ON l.usuario_id = u.id
      GROUP BY u.id, u.nome, u.matricula, d.nome
      ORDER BY u.nome ASC;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Listar Linhas
app.get('/api/linhas', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        l.*, 
        u.nome AS usuario_nome
      FROM linhas_telefonicas l
      LEFT JOIN usuarios u ON l.usuario_id = u.id
      ORDER BY l.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cadastrar Nova Linha
app.post('/api/linhas', upload.single('termo_pdf'), async (req, res) => {
  const { numero_linha, operadora, iccid_chip, plano, status, usuario_id, observacoes } = req.body;
  const termo_url = req.file ? `/uploads/${req.file.filename}` : (req.body.termo_url || null);

  try {
    const query = `
      INSERT INTO linhas_telefonicas 
      (numero_linha, operadora, iccid_chip, plano, status, usuario_id, termo_url, observacoes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `;
    const values = [
      numero_linha,
      operadora,
      iccid_chip,
      plano,
      status || 'Em Uso',
      usuario_id ? parseInt(usuario_id) : null,
      termo_url,
      observacoes
    ];
    await pool.query(query, values);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// INICIALIZAÇÃO DO SERVIDOR NA REDE
// ==========================================

const PORT = process.env.PORT || 8080;

// O IP '0.0.0.0' permite conexões de qualquer máquina da rede local
app.listen(PORT, '0.0.0.0', () => {
  console.log(`===================================================`);
  console.log(`Servidor rodando localmente em: http://localhost:${PORT}`);
  console.log(`Servidor acessível na rede em: http://10.64.10.100:${PORT}`);
  console.log(`===================================================`);
});