import express from 'express';
import cors from 'cors';
import { initializeApp } from 'firebase-admin/app'; // Puedes usar esto si sigues con import, pero...
import admin from 'firebase-admin';  // Aquí necesitas `require` para Firebase
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import * as dotenv from 'dotenv';
import { readFileSync } from 'fs';
// import googleCredentials from './utils/nomadamuebles-d3f29-c9e3acf57b37.json' assert { type: 'json' }; 
// Cargar variables de entorno
dotenv.config();
// Inicializar Firebase Admin SDK
// admin.initializeApp({
//   credential: admin.credential.cert(googleCredentials)
// });

const serviceAccount = JSON.parse(readFileSync('/etc/secrets/pdf-manager-7fbf8-129de6ca5512.json', 'utf-8'));
// Inicializar Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});


const firestore = admin.firestore();

// SDK de Mercado Pago
const client = new MercadoPagoConfig({ 
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN
});

const payment = new Payment(client);

const app = express();
const corsOptions = {
  origin: '*', // Cambia esto por el dominio permitido o usa '*' para todos.
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true // Permite incluir cookies si es necesario
};

app.options('*', cors(corsOptions));  // Permitir CORS en las solicitudes preflight
app.use(cors(corsOptions)); // Habilita CORS con opciones
app.use(express.json());

app.post('/create_preference', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  const { totalAmount, codigoFinal, deliveryMethod, discountAmount, nombreProducto, userData } = req.body;

  if (!userData) {
    return res.status(400).json({ error: 'Faltan los datos del usuario en la solicitud' });
  }

  const {
    telefono,
    nombre,
    apellido,
    email,
    ciudad,
    codigoPostal,
    provincia,
    departamento
  } = userData;

  try {
    // Generar un ID único para la orden de compra
    const orderId = createIdDoc();

    // Calcular el precio final con el descuento aplicado
    const originalPrice = totalAmount; // Precio sin descuento
    let finalPrice = totalAmount; // Precio con descuento aplicado

    if (discountAmount && discountAmount > 0 && discountAmount <= 100) {
      finalPrice = totalAmount - (totalAmount * (discountAmount / 100));
    }

    // Crear la preferencia de pago para MercadoPago
    const preference = new Preference(client);

    const result = await preference.create({
      body: {
        items: [
          {
            title: "Compra tu Isla",
            quantity: 1,
            unit_price: finalPrice, // Se envía el precio con descuento
            currency_id: "ARS",
          },
        ],
        back_urls: {
          success: 'www.masnomada.com/',
          failure: 'www.masnomada.com/',
        },
        auto_return: 'approved',
        notification_url: 'https://backnomada.onrender.com/payment_success',
        external_reference: orderId,
      },
    });

    const orderData = {
      nombre: nombre || '',
      apellido: apellido || '',
      email: email || '',
      telefono: telefono || '',
      ciudad: ciudad || '',
      codigoPostal: codigoPostal || '',
      provincia: provincia || '',
      departamento: departamento || '',
      codigoFinal: codigoFinal || '',
      originalPrice: originalPrice, // Se almacena el precio sin descuento
      finalPrice: finalPrice, // Se almacena el precio con descuento
      discountAmount: discountAmount || 0,
      nombreProducto: nombreProducto || '',
      deliveryMethod: deliveryMethod || '',
      preferenceId: result?.body?.id || result?.id || '',
      orderId: orderId || '',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    // Guardar los datos de la compra en Firestore en la colección "ordenesCompra"
    const orderDoc = firestore.collection('ordenesCompra').doc(orderId);
    await orderDoc.set(orderData);

    // Enviar la preferencia de MercadoPago y el ID de la orden al front-end
    return res.json({ ...result });
  } catch (error) {
    console.error('Error al crear la preferencia:', error);
    return res.status(500).json({ error: 'Error al crear la preferencia de pago' });
  }
});




// Implementación de la función para generar un ID único (similar a createIdDoc)
function createIdDoc() {
  return firestore.collection('dummyCollection').doc().id; // Usamos un doc temporal para generar el ID
}

app.post('/payment_success', async (req, res) => {
  try {
    const { type, data } = req.body;

    // Verifica si el cuerpo tiene el formato esperado
    if (!data || !data.id) {
      console.error("Invalid webhook payload: Missing 'data.id'");
      return res.status(400).json({ error: "Invalid webhook payload: Missing 'data.id'" });
    }

    const paymentId = data.id;

    console.log("Payment ID received from webhook: ", paymentId);
    console.log("Notification type: ", type);

    // Verifica si la notificación es del tipo "payment"
    if (type !== "payment") {
      console.warn(`Unhandled notification type: ${type}`);
      return res.status(400).json({ error: `Unhandled notification type: ${type}` });
    }

    // Verifica que las credenciales de MercadoPago estén configuradas correctamente
    if (!payment) {
      console.error("MercadoPago SDK not initialized");
      return res.status(500).json({ error: "Internal server error: MercadoPago SDK not initialized" });
    }

    let paymentInfo;
    try {
      // Realiza el get del pago usando el ID recibido
      paymentInfo = await payment.get({ id: paymentId });
      console.log("Payment Info: ", JSON.stringify(paymentInfo, null, 2));
    } catch (error) {
      console.error("Error fetching payment info: ", error);
      return res.status(500).json({ error: "Error fetching payment info" });
    }

    // Verifica que el pago esté aprobado
    if (!paymentInfo || paymentInfo.status !== "approved") {
      console.error("Payment not approved or not found");
      return res.status(400).json({ error: "Payment not approved or not found" });
    }

    const { external_reference } = paymentInfo;

    if (!external_reference) {
      console.error("No external reference found in payment info");
      return res.status(400).json({ error: "No external reference found in payment info" });
    }

    console.log("External reference: ", external_reference);

// Reemplaza "userId" con el nombre del campo correcto en tu Firestore
const querySnapshot = await firestore
  .collection("ordenesCompra")
  .where("orderId", "==", external_reference)
  .where("status", "!=", "completed") // Asegura que el estado no sea "completed"
  .get();

if (querySnapshot.empty) {
  console.error(`No pending order found in Firestore with external_reference: ${external_reference}`);
  return res.status(404).json({ error: "No pending order found" });
}

// Suponiendo que el external_reference sea único, tomamos el primer documento encontrado
const orderDoc = querySnapshot.docs[0];
const orderRef = orderDoc.ref;

// Actualiza Firestore con la información del pago
await orderRef.update({
  paymentDate: new Date(),
  status: "completed",
});

console.log(`Order successfully updated in Firestore: ${orderRef.id}`);

return res.status(200).json({ message: "Payment processed successfully" });


  } catch (error) {
    console.error("Error handling payment webhook: ", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});




// Iniciar el servidor
app.listen(process.env.PORT || 3333, () => {
  console.log("HTTP server running on port:", process.env.PORT || 3333);
});
