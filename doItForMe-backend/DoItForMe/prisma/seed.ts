import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const passwordJaume = await bcrypt.hash('Jaume1234.', 10);
  const passwordCristina = await bcrypt.hash('cristina1234.', 10);

  await prisma.taskComment.deleteMany({ where: { task: { creator: { email: { in: ['jaume@gmail.com', 'cristina@gmail.com'] } } } } });
  await prisma.offer.deleteMany({ where: { task: { creator: { email: { in: ['jaume@gmail.com', 'cristina@gmail.com'] } } } } });
  await prisma.task.deleteMany({ where: { creator: { email: { in: ['jaume@gmail.com', 'cristina@gmail.com'] } } } });
  await prisma.user.deleteMany({ where: { email: { in: ['jaume@gmail.com', 'cristina@gmail.com'] } } });

  const jaume = await prisma.user.create({
    data: {
      nombre: 'Jaume',
      email: 'jaume@gmail.com',
      password: passwordJaume,
      is_runner: true,
      balance: 50.0,
    },
  });

  const cristina = await prisma.user.create({
    data: {
      nombre: 'Cristina',
      email: 'cristina@gmail.com',
      password: passwordCristina,
      is_runner: true,
      balance: 50.0,
    },
  });

  await prisma.task.create({
    data: {
      titulo: 'Recoger paquete de correos',
      descripcion: 'Recoger un paquete en la oficina de correos y traerlo a casa.',
      categoria: 'RECADOS',
      estado: 'OPEN',
      precio_inicial: 10,
      creator_id: jaume.id,
    },
  });

  await prisma.task.create({
    data: {
      titulo: 'Hacer compra',
      descripcion: 'Comprar pack de huevos L y bolsa de patatas naturales de 5kg. Se paga en persona el ticket',
      categoria: 'COMPRAS',
      estado: 'OPEN',
      precio_inicial: 10,
      creator_id: jaume.id,
    },
  });

  await prisma.task.create({
    data: {
      titulo: 'Limpiar coche',
      descripcion: 'Limpiar el coche por dentro y por fuera',
      categoria: 'LIMPIEZA',
      estado: 'OPEN',
      precio_inicial: 15,
      creator_id: cristina.id,
    },
  });

  await prisma.task.create({
    data: {
      titulo: 'Recorrido Luceros-Elche',
      descripcion: 'Se necesita servicio de taxi para llevarme a la UMH el dia 20/06/2026',
      categoria: 'RECADOS',
      estado: 'OPEN',
      precio_inicial: 30,
      creator_id: cristina.id,
    },
  });

  console.log('Seeder completo');
  console.log('Users: Jaume (jaume@gmail.com) and Cristina (cristina@gmail.com)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
