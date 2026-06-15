import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cors from 'cors';

const app = express();
const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'secret';

app.use(cors());
app.use(express.json());

/**
 * Extiende la interfaz Request de Express para incluir el usuario decodificado del JWT.
 */
declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}

// ======================= MIDDLEWARE =======================

/**
 * Middleware de autenticación mediante JWT.
 * Verifica que el token Bearer sea válido y adjunta el payload decodificado a `req.user`.
 *
 * @param req  - Objeto de solicitud Express.
 * @param res  - Objeto de respuesta Express.
 * @param next - Función para continuar con el siguiente middleware.
 * @returns Responde con 401 si el token falta o es inválido.
 */
const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No se proporcionó token de seguridad' });
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ error: 'Formato de token no válido' });
  }
  const token = parts[1];
  if (!token) return res.status(401).json({ error: 'No se proporcionó token de seguridad' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Token no válido o expirado' });
  }
};

/**
 * Enriquece un array de tareas con el recuento de ofertas y el precio más bajo.
 *
 * @typeParam T - Tipo que debe tener al menos la propiedad `id: number`.
 * @param tasks - Lista de tareas a enriquecer.
 * @returns Lista de tareas con las propiedades `offers_count` y `lowest_offer_price`.
 */
const withOfferSummary = async <T extends { id: number }>(tasks: T[]) => {
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

/**
 * Obtiene una tarea con sus ofertas para un usuario específico.
 * Si el usuario es el creador, ve todas las ofertas; si es un runner, solo las suyas.
 *
 * @param taskId - ID de la tarea.
 * @param userId - ID del usuario que realiza la consulta.
 * @returns La tarea con ofertas y resumen, o `null` si no existe.
 */
const getTaskForUser = async (taskId: number, userId: number) => {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      creator: { select: { id: true, nombre: true, rating: true } },
      runner: { select: { id: true, nombre: true, rating: true } },
    },
  });

  if (!task) return null;

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

/**
 * Normaliza un comentario opcional: si es undefined/null o queda vacío tras recortar, devuelve null.
 *
 * @param comment - Valor a normalizar.
 * @returns El texto recortado o null.
 */
const normalizeOptionalComment = (comment: unknown) => {
  if (comment === undefined || comment === null) return null;
  const trimmed = String(comment).trim();
  return trimmed ? trimmed : null;
};

/**
 * Valida el acceso a los comentarios de una tarea.
 * Solo el creador y el runner asignado pueden ver comentarios, y solo cuando la tarea no está OPEN.
 *
 * @param taskId - ID de la tarea.
 * @param userId - ID del usuario solicitante.
 * @returns Objeto con la tarea (o null), mensaje de error (o null) y código HTTP.
 */
const getTaskForComments = async (taskId: number, userId: number) => {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return { task: null, error: 'Tarea no encontrada', status: 404 };
  if (task.estado === 'OPEN' || !task.runner_id) {
    return { task, error: 'Los comentarios están disponibles después de aceptar una oferta', status: 400 };
  }
  if (task.creator_id !== userId && task.runner_id !== userId) {
    return { task, error: 'Solo el creador de la tarea y el ejecutor asignado pueden acceder a los comentarios', status: 403 };
  }
  return { task, error: null, status: 200 };
};

// ======================= AUTH =======================

/**
 * POST /api/auth/register
 * Registra un nuevo usuario.
 * @bodyParam {string} nombre - Nombre del usuario.
 * @bodyParam {string} email - Correo electrónico (único).
 * @bodyParam {string} password - Contraseña.
 * @bodyParam {boolean} [is_runner] - Indica si el usuario es ejecutor.
 * @returns 201 con el ID del usuario creado.
 * @returns 409 si el email ya está registrado.
 */
app.post('/api/auth/register', async (req: Request, res: Response) => {
  const { nombre, email, password, is_runner } = req.body;
  if (!nombre || !email || !password) {
    return res.status(400).json({ error: 'El nombre, email y contraseña son obligatorios' });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { nombre, email, password: hashedPassword, is_runner: !!is_runner },
    });
    res.status(201).json({ message: 'Usuario creado', userId: user.id });
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Este correo electrónico ya está registrado' });
    }
    res.status(400).json({ error: 'Error al crear el usuario', detalles: error.message });
  }
});

/**
 * POST /api/auth/login
 * Inicia sesión y devuelve un token JWT.
 * @bodyParam {string} email - Correo electrónico.
 * @bodyParam {string} password - Contraseña.
 * @returns 200 con el token JWT y datos del usuario.
 * @returns 401 si las credenciales son inválidas.
 */
app.post('/api/auth/login', async (req: Request, res: Response) => {
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
    if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: 'Credenciales inválidas' });
    const token = jwt.sign(
      { userId: user.id, is_runner: user.is_runner },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({
      token,
      user: {
        id: user.id,
        nombre: user.nombre,
        email: user.email,
        is_runner: user.is_runner,
        rating: user.rating,
        balance: user.balance,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ======================= USERS =======================

/**
 * GET /api/users/me
 * Devuelve el perfil del usuario autenticado con estadísticas.
 * @returns 200 con datos del usuario, tasa de finalización y tareas completadas.
 */
app.get('/api/users/me', requireAuth, async (req: Request, res: Response) => {
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
        balance: true,
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
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

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
  } catch (error: any) {
    res.status(500).json({ error: 'Error al obtener el usuario' });
  }
});

/**
 * PUT /api/users/me
 * Actualiza el perfil del usuario autenticado.
 * @bodyParam {string} nombre - Nuevo nombre.
 * @bodyParam {string} email - Nuevo email (debe ser único).
 * @bodyParam {boolean} [is_runner] - Nuevo rol de ejecutor.
 * @returns 200 con los datos actualizados del usuario.
 */
app.put('/api/users/me', requireAuth, async (req: Request, res: Response) => {
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

    const updateData: any = {
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
        balance: true,
        createdAt: true,
      },
    });

    res.json(updatedUser);
  } catch (error: any) {
    res.status(500).json({ error: 'Error al actualizar el perfil del usuario', detalles: error.message });
  }
});

/**
 * POST /api/users/add-funds
 * Añade fondos al saldo del usuario autenticado.
 * @bodyParam {number} amount - Cantidad a añadir (debe ser positiva).
 * @returns 200 con los datos actualizados del usuario.
 */
app.post('/api/users/add-funds', requireAuth, async (req: Request, res: Response) => {
  const amount = parseFloat(req.body.amount);
  if (isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Cantidad no válida' });
  }
  try {
    const updatedUser = await prisma.user.update({
      where: { id: req.user.userId },
      data: { balance: { increment: amount } },
      select: {
        id: true,
        nombre: true,
        email: true,
        rating: true,
        is_runner: true,
        balance: true,
        createdAt: true,
      }
    });
    res.json(updatedUser);
  } catch (error: any) {
    res.status(500).json({ error: 'Error al añadir fondos' });
  }
});

/**
 * POST /api/users/withdraw-funds
 * Retira fondos del saldo del usuario autenticado.
 * @bodyParam {number} amount - Cantidad a retirar (debe ser positiva y no superar el saldo).
 * @returns 200 con los datos actualizados del usuario.
 * @returns 400 si el saldo es insuficiente.
 */
app.post('/api/users/withdraw-funds', requireAuth, async (req: Request, res: Response) => {
  const amount = parseFloat(req.body.amount);
  if (isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Cantidad no válida' });
  }
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (user.balance < amount) {
      return res.status(400).json({ error: `Saldo insuficiente. Tu saldo actual es ${user.balance.toFixed(2)}€` });
    }
    const updatedUser = await prisma.user.update({
      where: { id: req.user.userId },
      data: { balance: { decrement: amount } },
      select: {
        id: true,
        nombre: true,
        email: true,
        rating: true,
        is_runner: true,
        balance: true,
        createdAt: true,
      }
    });
    res.json(updatedUser);
  } catch (error: any) {
    res.status(500).json({ error: 'Error al retirar fondos' });
  }
});

// ======================= TASKS =======================

/**
 * GET /api/tasks
 * Lista todas las tareas abiertas (excluye las del usuario autenticado).
 * @returns 200 con array de tareas enriquecidas con resumen de ofertas.
 */
app.get('/api/tasks', requireAuth, async (req: Request, res: Response) => {
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
  } catch (error: any) {
    res.status(500).json({ error: 'Error al obtener las tareas' });
  }
});

/**
 * GET /api/tasks/mine
 * Lista las tareas creadas por el usuario autenticado, incluyendo ofertas.
 * @returns 200 con array de tareas del usuario.
 */
app.get('/api/tasks/mine', requireAuth, async (req: Request, res: Response) => {
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
  } catch (error: any) {
    res.status(500).json({ error: 'Error al obtener las tareas' });
  }
});

/**
 * GET /api/tasks/:id
 * Devuelve el detalle de una tarea con sus ofertas.
 * @pathParam {number} id - ID de la tarea.
 * @returns 200 con la tarea, ofertas y resumen.
 * @returns 404 si la tarea no existe.
 */
app.get('/api/tasks/:id', requireAuth, async (req: Request, res: Response) => {
  const taskId = parseInt(req.params.id as string);
  if (isNaN(taskId)) return res.status(400).json({ error: 'ID de tarea no válido' });
  try {
    const task = await getTaskForUser(taskId, req.user.userId);
    if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
    res.json(task);
  } catch (error: any) {
    res.status(500).json({ error: 'Error al obtener la tarea' });
  }
});

/**
 * POST /api/tasks
 * Crea una nueva tarea.
 * @bodyParam {string} titulo - Título de la tarea.
 * @bodyParam {string} descripcion - Descripción de la tarea.
 * @bodyParam {string} categoria - Categoría de la tarea.
 * @bodyParam {number} precio_inicial - Precio inicial ofrecido.
 * @bodyParam {number} [lat] - Latitud de la ubicación.
 * @bodyParam {number} [lng] - Longitud de la ubicación.
 * @returns 201 con la tarea creada.
 */
app.post('/api/tasks', requireAuth, async (req: Request, res: Response) => {
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
  } catch (error: any) {
    res.status(400).json({ error: 'Error al crear la tarea', detalles: error.message });
  }
});

/**
 * PATCH /api/tasks/:id/complete
 * Marca una tarea asignada como completada. Transfiere el pago al runner y actualiza su rating.
 * @pathParam {number} id - ID de la tarea.
 * @bodyParam {number} [rating] - Valoración del runner (1-5).
 * @returns 200 con mensaje de éxito y tarea actualizada.
 * @returns 403 si no es el creador.
 * @returns 400 si la tarea no está asignada.
 */
app.patch('/api/tasks/:id/complete', requireAuth, async (req: Request, res: Response) => {
  const taskId = parseInt(req.params.id as string);
  const rating = req.body.rating !== undefined && req.body.rating !== null ? parseFloat(req.body.rating) : null;

  if (isNaN(taskId)) return res.status(400).json({ error: 'ID de tarea no válido' });
  if (rating !== null && (isNaN(rating) || rating < 1 || rating > 5)) {
    return res.status(400).json({ error: 'La valoración debe ser un número entre 1 y 5' });
  }

  try {
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
    if (task.creator_id !== req.user.userId) {
      return res.status(403).json({ error: 'Solo el creador de la tarea puede completarla' });
    }
    if (task.estado !== 'ASSIGNED') {
      return res.status(400).json({ error: 'Solo las tareas asignadas se pueden marcar como completadas' });
    }

    let newRating: number | undefined;
    if (rating !== null && task.runner_id) {
      const runner = await prisma.user.findUnique({ where: { id: task.runner_id } });
      if (runner) {
        const completedTasksCount = await prisma.task.count({
          where: { runner_id: task.runner_id, estado: 'COMPLETED', NOT: { id: taskId } }
        });
        const currentRating = runner.rating || 0;

        newRating = completedTasksCount > 0 
          ? ((currentRating * completedTasksCount) + rating) / (completedTasksCount + 1)
          : rating;
      }
    }

    const price = task.precio_final ?? task.precio_inicial;

    const [updated] = await prisma.$transaction([
      prisma.task.update({
        where: { id: taskId },
        data: { estado: 'COMPLETED' },
      }),
      ...(task.runner_id ? [
        prisma.user.update({
          where: { id: task.runner_id },
          data: {
            balance: { increment: price },
            ...(newRating !== undefined ? { rating: newRating } : {}),
          },
        })
      ] : []),
    ]);

    res.json({ message: 'Tarea marcada como completada', task: updated });
  } catch (error: any) {
    res.status(500).json({ error: 'Error al completar la tarea', detalles: error.message });
  }
});

/**
 * PATCH /api/tasks/:id/cancel
 * Cancela una tarea (solo si no está COMPLETED o CANCELLED).
 * @pathParam {number} id - ID de la tarea.
 * @returns 200 con mensaje de éxito y tarea actualizada.
 * @returns 403 si no es el creador.
 * @returns 400 si la tarea ya está completada o cancelada.
 */
app.patch('/api/tasks/:id/cancel', requireAuth, async (req: Request, res: Response) => {
  const taskId = parseInt(req.params.id as string);
  if (isNaN(taskId)) return res.status(400).json({ error: 'ID de tarea no válido' });
  try {
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
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
  } catch (error: any) {
    res.status(500).json({ error: 'Error al cancelar la tarea' });
  }
});

/**
 * GET /api/tasks/:id/comments
 * Obtiene los comentarios de una tarea (solo creador y runner asignado).
 * @pathParam {number} id - ID de la tarea.
 * @returns 200 con array de comentarios.
 */
app.get('/api/tasks/:id/comments', requireAuth, async (req: Request, res: Response) => {
  const taskId = parseInt(req.params.id as string);
  if (isNaN(taskId)) return res.status(400).json({ error: 'ID de tarea no válido' });
  try {
    const access = await getTaskForComments(taskId, req.user.userId);
    if (access.error) return res.status(access.status).json({ error: access.error });

    const comments = await prisma.taskComment.findMany({
      where: { task_id: taskId },
      include: {
        author: { select: { id: true, nombre: true, rating: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json(comments);
  } catch (error: any) {
    res.status(500).json({ error: 'Error al obtener los comentarios' });
  }
});

/**
 * POST /api/tasks/:id/comments
 * Añade un comentario a una tarea (solo creador y runner asignado).
 * @pathParam {number} id - ID de la tarea.
 * @bodyParam {string} body - Contenido del comentario.
 * @returns 201 con el comentario creado.
 */
app.post('/api/tasks/:id/comments', requireAuth, async (req: Request, res: Response) => {
  const taskId = parseInt(req.params.id as string);
  const body = String(req.body.body ?? '').trim();
  if (isNaN(taskId)) return res.status(400).json({ error: 'ID de tarea no válido' });
  if (!body) return res.status(400).json({ error: 'El contenido del comentario es obligatorio' });
  try {
    const access = await getTaskForComments(taskId, req.user.userId);
    if (access.error) return res.status(access.status).json({ error: access.error });

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
  } catch (error: any) {
    res.status(500).json({ error: 'Error al crear el comentario', detalles: error.message });
  }
});

// ======================= OFFERS =======================

/**
 * GET /api/offers/mine
 * Lista las ofertas del runner autenticado con los datos de la tarea asociada.
 * @returns 200 con array de ofertas.
 */
app.get('/api/offers/mine', requireAuth, async (req: Request, res: Response) => {
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
  } catch (error: any) {
    res.status(500).json({ error: 'Error al obtener las ofertas' });
  }
});

/**
 * PATCH /api/offers/:id
 * Actualiza una oferta pendiente del runner autenticado.
 * @pathParam {number} id - ID de la oferta.
 * @bodyParam {number} precio_propuesto - Nuevo precio propuesto.
 * @bodyParam {string} [mensaje] - Nuevo mensaje.
 * @returns 200 con la oferta actualizada.
 * @returns 403 si no es el dueño de la oferta.
 * @returns 400 si la oferta no está pendiente o la tarea no está abierta.
 */
app.patch('/api/offers/:id', requireAuth, async (req: Request, res: Response) => {
  const offerId = parseInt(req.params.id as string);
  const { precio_propuesto, mensaje } = req.body;
  if (isNaN(offerId)) return res.status(400).json({ error: 'ID de oferta no válido' });
  if (precio_propuesto === undefined) {
    return res.status(400).json({ error: 'El precio propuesto es obligatorio' });
  }

  try {
    const offer = await prisma.offer.findUnique({
      where: { id: offerId },
      include: { task: true },
    });
    if (!offer) return res.status(404).json({ error: 'Oferta no encontrada' });
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
  } catch (error: any) {
    res.status(400).json({ error: 'Error al actualizar la oferta', detalles: error.message });
  }
});

/**
 * DELETE /api/offers/:id
 * Elimina una oferta pendiente del runner autenticado.
 * @pathParam {number} id - ID de la oferta.
 * @returns 200 con mensaje de éxito.
 * @returns 403 si no es el dueño.
 * @returns 400 si la oferta no está pendiente.
 */
app.delete('/api/offers/:id', requireAuth, async (req: Request, res: Response) => {
  const offerId = parseInt(req.params.id as string);
  if (isNaN(offerId)) return res.status(400).json({ error: 'ID de oferta no válido' });

  try {
    const offer = await prisma.offer.findUnique({
      where: { id: offerId },
      include: { task: true },
    });
    if (!offer) return res.status(404).json({ error: 'Oferta no encontrada' });
    if (offer.runner_id !== req.user.userId) {
      return res.status(403).json({ error: 'Solo el dueño de la oferta puede eliminarla' });
    }
    if (offer.estado !== 'PENDING') {
      return res.status(400).json({ error: 'Solo se pueden eliminar ofertas pendientes' });
    }

    await prisma.offer.delete({ where: { id: offerId } });
    res.json({ message: 'Oferta eliminada' });
  } catch (error: any) {
    res.status(500).json({ error: 'Error al eliminar la oferta', detalles: error.message });
  }
});

/**
 * POST /api/offers
 * El runner envía una oferta para una tarea abierta.
 * @bodyParam {number} task_id - ID de la tarea.
 * @bodyParam {number} precio_propuesto - Precio propuesto.
 * @bodyParam {string} [mensaje] - Mensaje opcional.
 * @returns 201 con la oferta creada.
 * @returns 409 si ya existe una oferta pendiente del mismo runner.
 */
app.post('/api/offers', requireAuth, async (req: Request, res: Response) => {
  const { task_id, precio_propuesto, mensaje } = req.body;
  if (!task_id || precio_propuesto === undefined) {
    return res.status(400).json({ error: 'El ID de la tarea y el precio propuesto son obligatorios' });
  }
  try {
    const task = await prisma.task.findUnique({ where: { id: parseInt(task_id) } });
    if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
    if (task.estado !== 'OPEN') return res.status(400).json({ error: 'La tarea no está abierta' });
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
  } catch (error: any) {
    res.status(400).json({ error: 'Error al crear la oferta', detalles: error.message });
  }
});

/**
 * PATCH /api/offers/:id/accept
 * El creador de la tarea acepta una oferta. Rechaza las demás, asigna la tarea y descuenta el saldo.
 * @pathParam {number} id - ID de la oferta.
 * @bodyParam {string} [comment] - Comentario opcional al aceptar.
 * @returns 200 con mensaje de éxito y tarea actualizada.
 * @returns 400 si el saldo es insuficiente.
 * @returns 403 si no es el creador de la tarea.
 */
app.patch('/api/offers/:id/accept', requireAuth, async (req: Request, res: Response) => {
  const offerId = parseInt(req.params.id as string);
  const comment = normalizeOptionalComment(req.body.comment);
  if (isNaN(offerId)) return res.status(400).json({ error: 'ID de oferta no válido' });
  try {
    const offer = await prisma.offer.findUnique({ where: { id: offerId }, include: { task: true } });
    if (!offer) return res.status(404).json({ error: 'Oferta no encontrada' });
    if (offer.task.creator_id !== req.user.userId) {
      return res.status(403).json({ error: 'Solo el creador de la tarea puede aceptar una oferta' });
    }
    if (offer.task.estado !== 'OPEN') {
      return res.status(400).json({ error: 'La tarea no está abierta' });
    }
    if (offer.estado !== 'PENDING') {
      return res.status(400).json({ error: 'La oferta no está pendiente' });
    }

    const creator = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!creator) return res.status(404).json({ error: 'Creador no encontrado' });
    if (creator.balance < offer.precio_propuesto) {
      return res.status(400).json({ error: `Saldo insuficiente (${creator.balance.toFixed(2)}€ disponible)` });
    }

    // Transaction: accept this offer, reject others, update task, decrement creator balance
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
      prisma.user.update({
        where: { id: req.user.userId },
        data: { balance: { decrement: offer.precio_propuesto } },
      }),
    ]);
    res.json({ message: 'Oferta aceptada con éxito', task: result[2] });
  } catch (error: any) {
    res.status(500).json({ error: 'Error al aceptar la oferta', detalles: error.message });
  }
});

/**
 * PATCH /api/offers/:id/reject
 * El creador de la tarea rechaza una oferta pendiente.
 * @pathParam {number} id - ID de la oferta.
 * @bodyParam {string} [comment] - Comentario opcional al rechazar.
 * @returns 200 con mensaje de éxito y oferta actualizada.
 * @returns 403 si no es el creador de la tarea.
 */
app.patch('/api/offers/:id/reject', requireAuth, async (req: Request, res: Response) => {
  const offerId = parseInt(req.params.id as string);
  const comment = normalizeOptionalComment(req.body.comment);
  if (isNaN(offerId)) return res.status(400).json({ error: 'ID de oferta no válido' });
  try {
    const offer = await prisma.offer.findUnique({ where: { id: offerId }, include: { task: true } });
    if (!offer) return res.status(404).json({ error: 'Oferta no encontrada' });
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
  } catch (error: any) {
    res.status(500).json({ error: 'Error al rechazar la oferta', detalles: error.message });
  }
});

// ======================= HEALTH =======================
app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});

// ======================= SERVER =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
