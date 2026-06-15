"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const client_1 = require("@prisma/client");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const cors_1 = __importDefault(require("cors"));
const app = (0, express_1.default)();
const prisma = new client_1.PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'secret';
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// ======================= MIDDLEWARE =======================
const requireAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader)
        return res.status(401).json({ error: 'No se proporcionó token de seguridad' });
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
        return res.status(401).json({ error: 'Formato de token no válido' });
    }
    const token = parts[1];
    if (!token)
        return res.status(401).json({ error: 'No se proporcionó token de seguridad' });
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    }
    catch (err) {
        res.status(401).json({ error: 'Token no válido o expirado' });
    }
};
const withOfferSummary = async (tasks) => {
    return Promise.all(tasks.map(async (task) => {
        const summary = await prisma.offer.aggregate({
            where: { task_id: task.id },
            _count: { _all: true },
            _min: { precio_propuesto: true },
        });
        return {
            ...task,
            offers_count: summary._count._all,
            lowest_offer_price: summary._min.precio_propuesto,
        };
    }));
};
const getTaskForUser = async (taskId, userId) => {
    const task = await prisma.task.findUnique({
        where: { id: taskId },
        include: {
            creator: { select: { id: true, nombre: true, rating: true } },
            runner: { select: { id: true, nombre: true, rating: true } },
        },
    });
    if (!task)
        return null;
    const [summary, offers] = await Promise.all([
        prisma.offer.aggregate({
            where: { task_id: taskId },
            _count: { _all: true },
            _min: { precio_propuesto: true },
        }),
        prisma.offer.findMany({
            where: task.creator_id === userId ? { task_id: taskId } : { task_id: taskId, runner_id: userId },
            include: {
                runner: { select: { id: true, nombre: true, rating: true } },
            },
            orderBy: { createdAt: 'desc' },
        }),
    ]);
    return {
        ...task,
        offers,
        offers_count: summary._count._all,
        lowest_offer_price: summary._min.precio_propuesto,
    };
};
const normalizeOptionalComment = (comment) => {
    if (comment === undefined || comment === null)
        return null;
    const trimmed = String(comment).trim();
    return trimmed ? trimmed : null;
};
const getTaskForComments = async (taskId, userId) => {
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task)
        return { task: null, error: 'Tarea no encontrada', status: 404 };
    if (task.estado === 'OPEN' || !task.runner_id) {
        return { task, error: 'Los comentarios están disponibles después de aceptar una oferta', status: 400 };
    }
    if (task.creator_id !== userId && task.runner_id !== userId) {
        return { task, error: 'Solo el creador de la tarea y el ejecutor asignado pueden acceder a los comentarios', status: 403 };
    }
    return { task, error: null, status: 200 };
};
// ======================= AUTH =======================
// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
    const { nombre, email, password, is_runner } = req.body;
    if (!nombre || !email || !password) {
        return res.status(400).json({ error: 'El nombre, email y contraseña son obligatorios' });
    }
    try {
        const hashedPassword = await bcryptjs_1.default.hash(password, 10);
        const user = await prisma.user.create({
            data: { nombre, email, password: hashedPassword, is_runner: !!is_runner },
        });
        res.status(201).json({ message: 'Usuario creado', userId: user.id });
    }
    catch (error) {
        if (error.code === 'P2002') {
            return res.status(409).json({ error: 'Este correo electrónico ya está registrado' });
        }
        res.status(400).json({ error: 'Error al crear el usuario', detalles: error.message });
    }
});
// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'El email y la contraseña son obligatorios' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Formato de correo no válido' });
    }
    if (typeof password !== 'string' || password.length < 4) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
    }
    try {
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user)
            return res.status(401).json({ error: 'Credenciales inválidas' });
        const isMatch = await bcryptjs_1.default.compare(password, user.password);
        if (!isMatch)
            return res.status(401).json({ error: 'Credenciales inválidas' });
        const token = jsonwebtoken_1.default.sign({ userId: user.id, is_runner: user.is_runner }, JWT_SECRET, { expiresIn: '7d' });
        res.json({
            token,
            user: {
                id: user.id,
                nombre: user.nombre,
                email: user.email,
                is_runner: user.is_runner,
                rating: user.rating,
            },
        });
    }
    catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
// ======================= USERS =======================
// GET /api/users/me
app.get('/api/users/me', requireAuth, async (req, res) => {
    try {
        const userId = req.user.userId;
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                nombre: true,
                email: true,
                rating: true,
                is_runner: true,
                createdAt: true,
                _count: {
                    select: {
                        tasksCreated: true,
                        tasksAssigned: true,
                        offers: true,
                    },
                },
            },
        });
        if (!user)
            return res.status(404).json({ error: 'Usuario no encontrado' });
        const completedTasksCount = await prisma.task.count({
            where: { runner_id: userId, estado: 'COMPLETED' }
        });
        const cancelledTasksCount = await prisma.task.count({
            where: { runner_id: userId, estado: 'CANCELLED' }
        });
        const totalFinished = completedTasksCount + cancelledTasksCount;
        const completionRate = totalFinished > 0 ? Math.round((completedTasksCount / totalFinished) * 100) : 100;
        res.json({
            ...user,
            completionRate,
            completedTasksCount
        });
    }
    catch (error) {
        res.status(500).json({ error: 'Error al obtener el usuario' });
    }
});
// PUT /api/users/me
app.put('/api/users/me', requireAuth, async (req, res) => {
    const { nombre, email, is_runner } = req.body;
    if (!nombre || !email) {
        return res.status(400).json({ error: 'El nombre y el email son obligatorios' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Formato de correo no válido' });
    }
    try {
        const userId = req.user.userId;
        const existingUser = await prisma.user.findFirst({
            where: {
                email,
                NOT: { id: userId },
            },
        });
        if (existingUser) {
            return res.status(409).json({ error: 'Este correo electrónico ya está registrado' });
        }
        const updateData = {
            nombre,
            email,
        };
        if (is_runner !== undefined) {
            updateData.is_runner = !!is_runner;
        }
        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: updateData,
            select: {
                id: true,
                nombre: true,
                email: true,
                rating: true,
                is_runner: true,
                createdAt: true,
            },
        });
        res.json(updatedUser);
    }
    catch (error) {
        res.status(500).json({ error: 'Error al actualizar el perfil del usuario', detalles: error.message });
    }
});
// ======================= TASKS =======================
// GET /api/tasks — all OPEN tasks (excluding user's own)
app.get('/api/tasks', requireAuth, async (req, res) => {
    try {
        const tasks = await prisma.task.findMany({
            where: { estado: 'OPEN' },
            include: {
                creator: { select: { id: true, nombre: true, rating: true } },
                _count: { select: { offers: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
        res.json(await withOfferSummary(tasks));
    }
    catch (error) {
        res.status(500).json({ error: 'Error al obtener las tareas' });
    }
});
// GET /api/tasks/mine — tasks created by the current user
app.get('/api/tasks/mine', requireAuth, async (req, res) => {
    try {
        const tasks = await prisma.task.findMany({
            where: { creator_id: req.user.userId },
            include: {
                creator: { select: { id: true, nombre: true, rating: true } },
                runner: { select: { id: true, nombre: true, rating: true } },
                offers: {
                    include: {
                        runner: { select: { id: true, nombre: true, rating: true } },
                    },
                    orderBy: { createdAt: 'desc' },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
        res.json(tasks);
    }
    catch (error) {
        res.status(500).json({ error: 'Error al obtener las tareas' });
    }
});
// GET /api/tasks/:id — task detail with offers
app.get('/api/tasks/:id', requireAuth, async (req, res) => {
    const taskId = parseInt(req.params.id);
    if (isNaN(taskId))
        return res.status(400).json({ error: 'ID de tarea no válido' });
    try {
        const task = await getTaskForUser(taskId, req.user.userId);
        if (!task)
            return res.status(404).json({ error: 'Tarea no encontrada' });
        res.json(task);
    }
    catch (error) {
        res.status(500).json({ error: 'Error al obtener la tarea' });
    }
});
// POST /api/tasks — create a new task
app.post('/api/tasks', requireAuth, async (req, res) => {
    const { titulo, descripcion, categoria, precio_inicial, lat, lng } = req.body;
    if (!titulo || !descripcion || !categoria || precio_inicial === undefined) {
        return res.status(400).json({ error: 'El título, descripción, categoría y precio inicial son obligatorios' });
    }
    try {
        const task = await prisma.task.create({
            data: {
                titulo,
                descripcion,
                categoria,
                precio_inicial: parseFloat(precio_inicial),
                lat: lat ? parseFloat(lat) : null,
                lng: lng ? parseFloat(lng) : null,
                creator_id: req.user.userId,
            },
            include: {
                creator: { select: { id: true, nombre: true, rating: true } },
            },
        });
        res.status(201).json(task);
    }
    catch (error) {
        res.status(400).json({ error: 'Error al crear la tarea', detalles: error.message });
    }
});
// PATCH /api/tasks/:id/complete — mark a task as COMPLETED
app.patch('/api/tasks/:id/complete', requireAuth, async (req, res) => {
    const taskId = parseInt(req.params.id);
    const rating = req.body.rating !== undefined && req.body.rating !== null ? parseFloat(req.body.rating) : null;
    if (isNaN(taskId))
        return res.status(400).json({ error: 'ID de tarea no válido' });
    if (rating !== null && (isNaN(rating) || rating < 1 || rating > 5)) {
        return res.status(400).json({ error: 'La valoración debe ser un número entre 1 y 5' });
    }
    try {
        const task = await prisma.task.findUnique({ where: { id: taskId } });
        if (!task)
            return res.status(404).json({ error: 'Tarea no encontrada' });
        if (task.creator_id !== req.user.userId) {
            return res.status(403).json({ error: 'Solo el creador de la tarea puede completarla' });
        }
        if (task.estado !== 'ASSIGNED') {
            return res.status(400).json({ error: 'Solo las tareas asignadas se pueden marcar como completadas' });
        }
        // Update task status
        const updated = await prisma.task.update({
            where: { id: taskId },
            data: { estado: 'COMPLETED' },
        });
        if (rating !== null && task.runner_id) {
            const runner = await prisma.user.findUnique({ where: { id: task.runner_id } });
            if (runner) {
                const completedTasksCount = await prisma.task.count({
                    where: { runner_id: task.runner_id, estado: 'COMPLETED', NOT: { id: taskId } }
                });
                const currentRating = runner.rating || 0;
                const newRating = completedTasksCount > 0
                    ? ((currentRating * completedTasksCount) + rating) / (completedTasksCount + 1)
                    : rating;
                await prisma.user.update({
                    where: { id: task.runner_id },
                    data: { rating: newRating }
                });
            }
        }
        res.json({ message: 'Tarea marcada como completada', task: updated });
    }
    catch (error) {
        res.status(500).json({ error: 'Error al completar la tarea', detalles: error.message });
    }
});
// PATCH /api/tasks/:id/cancel — cancel a task
app.patch('/api/tasks/:id/cancel', requireAuth, async (req, res) => {
    const taskId = parseInt(req.params.id);
    if (isNaN(taskId))
        return res.status(400).json({ error: 'ID de tarea no válido' });
    try {
        const task = await prisma.task.findUnique({ where: { id: taskId } });
        if (!task)
            return res.status(404).json({ error: 'Tarea no encontrada' });
        if (task.creator_id !== req.user.userId) {
            return res.status(403).json({ error: 'Solo el creador de la tarea puede cancelarla' });
        }
        if (task.estado === 'COMPLETED' || task.estado === 'CANCELLED') {
            return res.status(400).json({ error: `No se puede cancelar una tarea con estado ${task.estado}` });
        }
        const updated = await prisma.task.update({
            where: { id: taskId },
            data: { estado: 'CANCELLED' },
        });
        res.json({ message: 'Tarea cancelada', task: updated });
    }
    catch (error) {
        res.status(500).json({ error: 'Error al cancelar la tarea' });
    }
});
// GET /api/tasks/:id/comments 
app.get('/api/tasks/:id/comments', requireAuth, async (req, res) => {
    const taskId = parseInt(req.params.id);
    if (isNaN(taskId))
        return res.status(400).json({ error: 'ID de tarea no válido' });
    try {
        const access = await getTaskForComments(taskId, req.user.userId);
        if (access.error)
            return res.status(access.status).json({ error: access.error });
        const comments = await prisma.taskComment.findMany({
            where: { task_id: taskId },
            include: {
                author: { select: { id: true, nombre: true, rating: true } },
            },
            orderBy: { createdAt: 'asc' },
        });
        res.json(comments);
    }
    catch (error) {
        res.status(500).json({ error: 'Error al obtener los comentarios' });
    }
});
// POST /api/tasks/:id/comments
app.post('/api/tasks/:id/comments', requireAuth, async (req, res) => {
    const taskId = parseInt(req.params.id);
    const body = String(req.body.body ?? '').trim();
    if (isNaN(taskId))
        return res.status(400).json({ error: 'ID de tarea no válido' });
    if (!body)
        return res.status(400).json({ error: 'El contenido del comentario es obligatorio' });
    try {
        const access = await getTaskForComments(taskId, req.user.userId);
        if (access.error)
            return res.status(access.status).json({ error: access.error });
        const comment = await prisma.taskComment.create({
            data: {
                task_id: taskId,
                author_id: req.user.userId,
                body,
            },
            include: {
                author: { select: { id: true, nombre: true, rating: true } },
            },
        });
        res.status(201).json(comment);
    }
    catch (error) {
        res.status(500).json({ error: 'Error al crear el comentario', detalles: error.message });
    }
});
// ======================= OFFERS =======================
// GET /api/offers/mine — runner gets their own offers and related tasks
app.get('/api/offers/mine', requireAuth, async (req, res) => {
    try {
        const offers = await prisma.offer.findMany({
            where: { runner_id: req.user.userId },
            include: {
                task: {
                    include: {
                        creator: { select: { id: true, nombre: true, rating: true } },
                    }
                }
            },
            orderBy: { createdAt: 'desc' },
        });
        res.json(offers);
    }
    catch (error) {
        res.status(500).json({ error: 'Error al obtener las ofertas' });
    }
});
// PATCH /api/offers/:id 
app.patch('/api/offers/:id', requireAuth, async (req, res) => {
    const offerId = parseInt(req.params.id);
    const { precio_propuesto, mensaje } = req.body;
    if (isNaN(offerId))
        return res.status(400).json({ error: 'ID de oferta no válido' });
    if (precio_propuesto === undefined) {
        return res.status(400).json({ error: 'El precio propuesto es obligatorio' });
    }
    try {
        const offer = await prisma.offer.findUnique({
            where: { id: offerId },
            include: { task: true },
        });
        if (!offer)
            return res.status(404).json({ error: 'Oferta no encontrada' });
        if (offer.runner_id !== req.user.userId) {
            return res.status(403).json({ error: 'Solo el dueño de la oferta puede editarla' });
        }
        if (offer.estado !== 'PENDING') {
            return res.status(400).json({ error: 'Solo se pueden editar ofertas pendientes' });
        }
        if (offer.task.estado !== 'OPEN') {
            return res.status(400).json({ error: 'Solo se pueden editar ofertas para tareas abiertas' });
        }
        const updated = await prisma.offer.update({
            where: { id: offerId },
            data: {
                precio_propuesto: parseFloat(precio_propuesto),
                mensaje,
            },
            include: {
                runner: { select: { id: true, nombre: true, rating: true } },
            },
        });
        res.json(updated);
    }
    catch (error) {
        res.status(400).json({ error: 'Error al actualizar la oferta', detalles: error.message });
    }
});
// DELETE /api/offers/:id — runner deletes their pending offer
app.delete('/api/offers/:id', requireAuth, async (req, res) => {
    const offerId = parseInt(req.params.id);
    if (isNaN(offerId))
        return res.status(400).json({ error: 'ID de oferta no válido' });
    try {
        const offer = await prisma.offer.findUnique({
            where: { id: offerId },
            include: { task: true },
        });
        if (!offer)
            return res.status(404).json({ error: 'Oferta no encontrada' });
        if (offer.runner_id !== req.user.userId) {
            return res.status(403).json({ error: 'Solo el dueño de la oferta puede eliminarla' });
        }
        if (offer.estado !== 'PENDING') {
            return res.status(400).json({ error: 'Solo se pueden eliminar ofertas pendientes' });
        }
        await prisma.offer.delete({ where: { id: offerId } });
        res.json({ message: 'Oferta eliminada' });
    }
    catch (error) {
        res.status(500).json({ error: 'Error al eliminar la oferta', detalles: error.message });
    }
});
// POST /api/offers — runner submits an offer
app.post('/api/offers', requireAuth, async (req, res) => {
    const { task_id, precio_propuesto, mensaje } = req.body;
    if (!task_id || precio_propuesto === undefined) {
        return res.status(400).json({ error: 'El ID de la tarea y el precio propuesto son obligatorios' });
    }
    try {
        const task = await prisma.task.findUnique({ where: { id: parseInt(task_id) } });
        if (!task)
            return res.status(404).json({ error: 'Tarea no encontrada' });
        if (task.estado !== 'OPEN')
            return res.status(400).json({ error: 'La tarea no está abierta' });
        if (task.creator_id === req.user.userId) {
            return res.status(400).json({ error: 'No puedes ofertar en tu propia tarea' });
        }
        // Check if user already has a pending offer for this task
        const existing = await prisma.offer.findFirst({
            where: { task_id: parseInt(task_id), runner_id: req.user.userId, estado: 'PENDING' },
        });
        if (existing) {
            return res.status(409).json({ error: 'Ya tienes una oferta pendiente para esta tarea' });
        }
        const offer = await prisma.offer.create({
            data: {
                task_id: parseInt(task_id),
                runner_id: req.user.userId,
                precio_propuesto: parseFloat(precio_propuesto),
                mensaje,
            },
            include: {
                runner: { select: { id: true, nombre: true, rating: true } },
            },
        });
        res.status(201).json(offer);
    }
    catch (error) {
        res.status(400).json({ error: 'Error al crear la oferta', detalles: error.message });
    }
});
// PATCH /api/offers/:id/accept — task creator accepts an offer
app.patch('/api/offers/:id/accept', requireAuth, async (req, res) => {
    const offerId = parseInt(req.params.id);
    const comment = normalizeOptionalComment(req.body.comment);
    if (isNaN(offerId))
        return res.status(400).json({ error: 'ID de oferta no válido' });
    try {
        const offer = await prisma.offer.findUnique({ where: { id: offerId }, include: { task: true } });
        if (!offer)
            return res.status(404).json({ error: 'Oferta no encontrada' });
        if (offer.task.creator_id !== req.user.userId) {
            return res.status(403).json({ error: 'Solo el creador de la tarea puede aceptar una oferta' });
        }
        if (offer.task.estado !== 'OPEN') {
            return res.status(400).json({ error: 'La tarea no está abierta' });
        }
        if (offer.estado !== 'PENDING') {
            return res.status(400).json({ error: 'La oferta no está pendiente' });
        }
        // Transaction: accept this offer, reject others, update task
        const result = await prisma.$transaction([
            prisma.offer.update({ where: { id: offerId }, data: { estado: 'ACCEPTED', comment } }),
            prisma.offer.updateMany({
                where: { task_id: offer.task_id, id: { not: offerId } },
                data: { estado: 'REJECTED' },
            }),
            prisma.task.update({
                where: { id: offer.task_id },
                data: {
                    estado: 'ASSIGNED',
                    runner_id: offer.runner_id,
                    precio_final: offer.precio_propuesto,
                },
            }),
        ]);
        res.json({ message: 'Oferta aceptada con éxito', task: result[2] });
    }
    catch (error) {
        res.status(500).json({ error: 'Error al aceptar la oferta', detalles: error.message });
    }
});
// PATCH /api/offers/:id/reject — task creator rejects a specific offer
app.patch('/api/offers/:id/reject', requireAuth, async (req, res) => {
    const offerId = parseInt(req.params.id);
    const comment = normalizeOptionalComment(req.body.comment);
    if (isNaN(offerId))
        return res.status(400).json({ error: 'ID de oferta no válido' });
    try {
        const offer = await prisma.offer.findUnique({ where: { id: offerId }, include: { task: true } });
        if (!offer)
            return res.status(404).json({ error: 'Oferta no encontrada' });
        if (offer.task.creator_id !== req.user.userId) {
            return res.status(403).json({ error: 'Solo el creador de la tarea puede rechazar una oferta' });
        }
        if (offer.estado !== 'PENDING') {
            return res.status(400).json({ error: 'La oferta no está pendiente' });
        }
        const updated = await prisma.offer.update({
            where: { id: offerId },
            data: { estado: 'REJECTED', comment },
            include: {
                runner: { select: { id: true, nombre: true, rating: true } },
            },
        });
        res.json({ message: 'Oferta rechazada', offer: updated });
    }
    catch (error) {
        res.status(500).json({ error: 'Error al rechazar la oferta', detalles: error.message });
    }
});
// ======================= SERVER =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
//# sourceMappingURL=index.js.map