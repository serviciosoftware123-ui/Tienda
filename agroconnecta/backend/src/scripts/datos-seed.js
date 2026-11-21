'use strict';
// Datos iniciales para la prueba piloto:
// categorías (con su tasa de IVA), 1 admin, 3 productores verificados (con parcelas), 1 acopiador,
// 1 productor en revisión, 2 compradores, transportistas aliados y anunciantes locales (ficticios).
const U = id => `https://images.unsplash.com/${id}?auto=format&fit=crop&q=80&w=900`;

module.exports = {
  categorias: [
    // IVA (art. 2-A LIVA): 0 % productos agrícolas sin industrializar, tractores para implementos y equipos de riego
    { nombre: 'Frutas Tropicales', tipo: 'CULTIVO', tasa_iva: 0 },
    { nombre: 'Granos y Cereales', tipo: 'CULTIVO', tasa_iva: 0 },
    { nombre: 'Hortalizas', tipo: 'CULTIVO', tasa_iva: 0 },
    { nombre: 'Herramientas de Campo', tipo: 'EQUIPO', tasa_iva: 0.16 },
    { nombre: 'Sistemas de Riego', tipo: 'EQUIPO', tasa_iva: 0 },
    { nombre: 'Tractores y Vehículos', tipo: 'MAQUINARIA', tasa_iva: 0.16 },
    { nombre: 'Terrenos Agrícolas', tipo: 'TERRENO', tasa_iva: 0 },
  ],

  vendedores: [
    {
      nombre: 'María', apellido: 'Hernández', email: 'platanos@agroconnecta.mx', telefono: '9371234567',
      nombre_negocio: 'Plátanos del Grijalva', rfc: 'HEMM850312AB1', ubicacion: 'Cárdenas, Tabasco',
      lat: 18.0042, lng: -93.3783,
      descripcion: 'Productores de plátano y frutas tropicales en la región de La Chontalpa desde 1998.',
      premium: true,      // usa el mes gratis de la alianza
      parcelas: [
        { slug: 'esperanza', nombre: 'Rancho La Esperanza', municipio: 'Cárdenas', superficie: 8, cultivo: 'Plátano', tenencia: 'PROPIA' },
        { slug: 'mangal', nombre: 'Huerta El Mangal', municipio: 'Cárdenas', superficie: 4, cultivo: 'Mango', tenencia: 'EJIDAL' },
        { slug: 'invernadero', nombre: 'Invernadero Cunduacán', municipio: 'Cunduacán', superficie: 0.5, cultivo: 'Chile habanero', tenencia: 'ARRENDADA' },
      ],
      productos: [
        { slug: 'platano-macho', parcela: 'esperanza', nombre: 'Plátano Tabasco Macho', categoria: 'Frutas Tropicales', precio: 8, stock: 12000, unidad: 'kg',
          ubicacion: 'Cárdenas, Tabasco', lat: 18.0042, lng: -93.3783, foto: U('photo-1571771894821-ce9b6c11b08e'),
          tags: ['platano', 'macho', 'tabasco', 'fruta', 'tostones'],
          descripcion: 'Plátano macho de Tabasco, calibre extra. Ideal para frituras, tostones y platillos tabasqueños. Cosecha semanal garantizada.' },
        { slug: 'platano-dominico', parcela: 'esperanza', nombre: 'Plátano Dominico Roatán', categoria: 'Frutas Tropicales', precio: 12, stock: 3000, unidad: 'kg',
          ubicacion: 'Paraíso, Tabasco', lat: 18.3997, lng: -93.2094, foto: U('photo-1481349518771-20055b2a7b24'),
          tags: ['platano', 'dominico', 'roatan', 'dulce'],
          descripcion: 'Plátano dominico variedad Roatán, pequeño y muy dulce. Para consumo fresco y deshidratado.' },
        { slug: 'mango-ataulfo', parcela: 'mangal', nombre: 'Mango Ataúlfo', categoria: 'Frutas Tropicales', precio: 22, stock: 5000, unidad: 'kg',
          ubicacion: 'Cárdenas, Tabasco', lat: 18.0, lng: -93.36, foto: U('photo-1553279768-865429fa0078'),
          tags: ['mango', 'ataulfo', 'fruta', 'tropical'],
          descripcion: 'Mango Ataúlfo de primera, pulpa firme sin fibra y sabor dulce intenso. Temporada abril–junio.' },
        { slug: 'chile-habanero', parcela: 'invernadero', nombre: 'Chile Habanero', categoria: 'Hortalizas', precio: 85, stock: 800, unidad: 'kg',
          ubicacion: 'Cunduacán, Tabasco', lat: 18.0667, lng: -93.1667, foto: U('photo-1588252303782-cb80119abd6d'),
          tags: ['chile', 'habanero', 'picante', 'salsa'],
          descripcion: 'Chile habanero naranja de invernadero, picor y aroma intensos. Ideal para salsas artesanales.' },
      ],
      terrenos: [
        { slug: 'terreno-huimanguillo', titulo: 'Terreno con riego 15 ha en Huimanguillo', operacion: 'ARRENDAMIENTO', precio: 28000,
          superficie: 15, ubicacion: 'Huimanguillo, Tabasco', lat: 17.8325, lng: -93.3897, foto: U('photo-1625246333195-78d9c38ad449'),
          tags: ['riego', 'horticultura', 'arrendamiento'],
          descripcion: 'Terreno de 15 ha con riego por goteo instalado. Ideal para horticultura intensiva. Arrendamiento anual (precio mensual).' },
      ],
    },
    {
      nombre: 'José', apellido: 'Ramírez', email: 'campodulce@agroconnecta.mx', telefono: '9331234567',
      nombre_negocio: 'Campo Dulce Agrícola', rfc: 'RAJJ790825CD2', ubicacion: 'Comalcalco, Tabasco',
      lat: 18.2767, lng: -93.2063,
      descripcion: 'Cacao, caña y granos de la región de Comalcalco. Venta directa del productor.',
      parcelas: [
        { slug: 'cacaotal', nombre: 'Finca Cacaotera San José', municipio: 'Comalcalco', superficie: 3, cultivo: 'Cacao', tenencia: 'PROPIA' },
        { slug: 'canaveral', nombre: 'Cañaveral El Zapote', municipio: 'Cárdenas', superficie: 10, cultivo: 'Caña de azúcar', tenencia: 'EJIDAL' },
        // 40 ha de maíz producen ~120 t al año: publicar 200 t dispara la alerta de volumen (demostración)
        { slug: 'milpa', nombre: 'Milpa Las Flores', municipio: 'Comalcalco', superficie: 40, cultivo: 'Maíz', tenencia: 'EJIDAL' },
      ],
      productos: [
        { slug: 'cacao-criollo', parcela: 'cacaotal', nombre: 'Cacao Criollo de Tabasco', categoria: 'Frutas Tropicales', precio: 95, stock: 1500, unidad: 'kg',
          ubicacion: 'Comalcalco, Tabasco', lat: 18.2767, lng: -93.2063, foto: U('photo-1548353373-090b02943e08'),
          tags: ['cacao', 'chocolate', 'criollo', 'artesanal'],
          descripcion: 'Cacao criollo fermentado y secado artesanalmente. Notas frutales y baja acidez, para chocolatería fina.' },
        { slug: 'cana-azucar', parcela: 'canaveral', nombre: 'Caña de Azúcar Criolla', categoria: 'Granos y Cereales', precio: 1200, stock: 500, unidad: 'tonelada',
          ubicacion: 'Cárdenas, Tabasco', lat: 17.99, lng: -93.40, foto: U('photo-1596591868231-05e808fd4e5b'),
          tags: ['caña', 'azucar', 'ingenio', 'piloncillo'],
          descripcion: 'Caña criolla con alta concentración de sacarosa, apta para ingenio y producción de piloncillo.' },
        { slug: 'maiz-blanco', parcela: 'milpa', nombre: 'Maíz Blanco Criollo', categoria: 'Granos y Cereales', precio: 8500, stock: 200, unidad: 'tonelada',
          ubicacion: 'Comalcalco, Tabasco', lat: 18.26, lng: -93.22, foto: U('photo-1551727041-5b347d65b633'),
          tags: ['maiz', 'grano', 'tortilla', 'criollo'],
          descripcion: 'Maíz blanco criollo de grano grueso, ideal para tortillas, pozol y tamales. Sin pesticidas sintéticos.' },
      ],
      terrenos: [
        { slug: 'terreno-cunduacan', titulo: 'Terreno agrícola 100 ha en Cunduacán', operacion: 'VENTA', precio: 8200000,
          superficie: 100, ubicacion: 'Cunduacán, Tabasco', lat: 18.0832, lng: -93.1668, foto: U('photo-1574943320219-553eb213f72d'),
          tags: ['terreno', 'agricola', 'rio', 'palma', 'caña'],
          descripcion: 'Terreno plano de 100 ha, suelo arcilloso-limoso de alta fertilidad. Colinda con río para riego.' },
        { slug: 'terreno-balancan', titulo: 'Campo productivo 40 ha en Balancán', operacion: 'ARRENDAMIENTO', precio: 45000,
          superficie: 40, ubicacion: 'Balancán, Tabasco', lat: 17.8013, lng: -91.5361, foto: U('photo-1464226184884-fa280b87c399'),
          tags: ['campo', 'cañero', 'aluvial', 'arrendamiento'],
          descripcion: 'Campo de 40 ha en zona cañera, suelo aluvial fértil. Arrendamiento por temporada (precio mensual).' },
      ],
    },
    {
      nombre: 'Luis', apellido: 'Pérez', email: 'maquiagro@agroconnecta.mx', telefono: '9931234567',
      nombre_negocio: 'MaquiAgro Sureste', rfc: 'PELL880101EF3', ubicacion: 'Villahermosa, Tabasco',
      lat: 17.9869, lng: -92.9303,
      descripcion: 'Maquinaria, herramienta y sistemas de riego para el campo del sureste.',
      parcelas: [],
      productos: [
        { slug: 'tractor-75hp', nombre: 'Tractor agrícola 75 HP con cabina', categoria: 'Tractores y Vehículos', precio: 485000, stock: 3, unidad: 'unidad',
          tasa_iva: 0,   // tractor de ruedas para implementos agrícolas: tasa 0 % (art. 2-A, fr. I, inciso e LIVA)
          ubicacion: 'Villahermosa, Tabasco', lat: 17.9869, lng: -92.9303, foto: U('photo-1594145070037-124976451664'),
          tags: ['tractor', 'maquinaria', '75hp'],
          descripcion: 'Tractor de 75 HP, transmisión sincronizada y cabina con aire acondicionado. Garantía de 12 meses.' },
        { slug: 'riego-goteo', nombre: 'Sistema de riego por goteo (1 ha)', categoria: 'Sistemas de Riego', precio: 18500, stock: 12, unidad: 'kit',
          ubicacion: 'Villahermosa, Tabasco', lat: 17.99, lng: -92.93, foto: null,
          tags: ['riego', 'goteo', 'cintilla', 'agua'],
          descripcion: 'Kit para 1 hectárea: cintilla, conectores, filtro de malla y válvulas. Incluye asesoría de instalación.' },
        { slug: 'kit-herramientas', nombre: 'Kit de herramientas de campo', categoria: 'Herramientas de Campo', precio: 1450, stock: 40, unidad: 'kit',
          ubicacion: 'Villahermosa, Tabasco', lat: 17.99, lng: -92.93, foto: null,
          tags: ['machete', 'azadon', 'pala', 'herramienta'],
          descripcion: 'Machete, azadón, pala recta, lima y guantes de trabajo. Acero templado.' },
      ],
      terrenos: [
        { slug: 'terreno-teapa', titulo: 'Rancho productivo 50 ha en Teapa', operacion: 'VENTA', precio: 3500000,
          superficie: 50, ubicacion: 'Teapa, Tabasco', lat: 17.5490, lng: -92.9520, foto: U('photo-1500382017468-9049fed747ef'),
          tags: ['rancho', 'ganaderia', 'pozo', 'bodega'],
          descripcion: 'Rancho de 50 ha con pozo propio, corrales y bodega. Acceso pavimentado. Apto para ganadería y agricultura.' },
      ],
    },
  ],

  // Acopiador: compra a varios productores y revende; paga 8 % de comisión y no sale en «Directo del productor»
  acopiador: {
    nombre: 'Ramiro', apellido: 'Gómez', email: 'acopio@agroconnecta.mx', telefono: '9938887766',
    nombre_negocio: 'Acopio Sureste', rfc: 'GORR800505GH4', ubicacion: 'Villahermosa, Tabasco',
    lat: 17.9869, lng: -92.9303, perfil: 'ACOPIADOR',
    descripcion: 'Centro de acopio en Villahermosa: compramos a productores de La Chontalpa y surtimos a distribuidores.',
    parcelas: [],
    productos: [
      { slug: 'platano-macho', nombre: 'Plátano macho (acopio, segunda)', categoria: 'Frutas Tropicales', precio: 7.5, stock: 20000, unidad: 'kg',
        ubicacion: 'Villahermosa, Tabasco', lat: 17.98, lng: -92.92, foto: null, tags: ['platano', 'acopio', 'mayoreo'],
        descripcion: 'Plátano macho de segunda reunido de varios productores. Venta por tonelada a distribuidores.' },
      { slug: 'cacao-criollo', nombre: 'Cacao seco (acopio)', categoria: 'Frutas Tropicales', precio: 88, stock: 3000, unidad: 'kg',
        ubicacion: 'Villahermosa, Tabasco', lat: 17.98, lng: -92.92, foto: null, tags: ['cacao', 'acopio'],
        descripcion: 'Cacao seco mezclado de productores de Comalcalco y Cunduacán.' },
    ],
    terrenos: [],
  },

  // Productor que acaba de registrarse: subió sus documentos y espera la revisión del admin
  enRevision: {
    nombre: 'Rosa', apellido: 'Jiménez', email: 'huerta@agroconnecta.mx', telefono: '9321234567',
    nombre_negocio: 'Huerta Los Ríos', rfc: 'JIMR900303JK5', ubicacion: 'Teapa, Tabasco', lat: 17.549, lng: -92.952,
    descripcion: 'Papaya maradol y limón persa de Teapa.',
    parcelas: [{ slug: 'rios', nombre: 'Huerta Los Ríos', municipio: 'Teapa', superficie: 6, cultivo: 'Papaya', tenencia: 'PROPIA' }],
    productos: [
      { slug: 'papaya', parcela: 'rios', nombre: 'Papaya Maradol', categoria: 'Frutas Tropicales', precio: 14, stock: 4000, unidad: 'kg',
        ubicacion: 'Teapa, Tabasco', lat: 17.549, lng: -92.952, foto: null, tags: ['papaya', 'maradol', 'fruta'],
        descripcion: 'Papaya maradol de corte fresco. Se mostrará en el catálogo cuando la productora sea verificada.' },
    ],
    terrenos: [],
  },

  transportistas: [
    { nombre: 'Fletes La Chontalpa', telefono: '9371100223', zona: 'Cárdenas, Huimanguillo, Cunduacán, Comalcalco', vehiculo: 'Camioneta 3.5 t con redilas', capacidad_ton: 3.5 },
    { nombre: 'Transportes Usumacinta', telefono: '9341203344', zona: 'Centro, Macuspana, Jonuta, Balancán, Tenosique', vehiculo: 'Rabón 8 t refrigerado', capacidad_ton: 8 },
    { nombre: 'Carga Sierra Teapa', telefono: '9323007788', zona: 'Teapa, Tacotalpa, Jalapa, Centro', vehiculo: 'Camioneta 1.5 t', capacidad_ton: 1.5 },
  ],

  // Anunciantes locales FICTICIOS (para mostrar la publicidad dentro de la plataforma)
  anunciantes: [
    { nombre: 'Semillas del Trópico', giro: 'Semillas', mensaje: 'Semilla certificada de maíz y hortalizas para el sureste. Asesoría gratis en tu parcela.',
      imagen_url: '/img/anuncios/semillas.svg', ubicacion: 'AMBOS', contacto: 'ventas@semillasdeltropico.example' },
    { nombre: 'FertiCampo Tabasco', giro: 'Fertilizantes', mensaje: 'Fertilizantes y abonos orgánicos con entrega en tu municipio. 10 % menos por volumen.',
      imagen_url: '/img/anuncios/ferticampo.svg', ubicacion: 'AMBOS', contacto: 'contacto@ferticampo.example' },
  ],

  compradores: [
    { nombre: 'Ana', apellido: 'López', email: 'comprador1@agroconnecta.mx', telefono: '9931112233',
      direccion: 'Av. Universidad s/n, Zona de la Cultura', ciudad: 'Villahermosa, Tabasco', municipio: 'Centro (Villahermosa)' },
    { nombre: 'Carlos', apellido: 'Méndez', email: 'comprador2@agroconnecta.mx', telefono: '9934445566',
      direccion: 'Calle Juárez 120, Centro', ciudad: 'Cunduacán, Tabasco', municipio: 'Cunduacán' },
  ],
};
