/* Tintas. No son las paletas del póster de mapa: aquí se imita papel impreso o
   escaneado, así que cada una es papel + tinta oscura + un tono medio para la
   traza y los textos secundarios. */
window.INKS = {
  cianotipo: {
    label: 'Cianotipo',
    paper: '#e8e4d6', ink: '#0d2c4d', mid: '#3f6d99', accent: '#14476f'
  },
  sepia: {
    label: 'Sepia',
    paper: '#efe6d2', ink: '#3a2412', mid: '#8a6a45', accent: '#6b4420'
  },
  grafito: {
    label: 'Grafito',
    paper: '#eceae6', ink: '#1d1d1f', mid: '#6f6f74', accent: '#3a3a3f'
  },
  riso: {
    label: 'Riso rojo',
    paper: '#f3ece2', ink: '#2a2118', mid: '#c2412f', accent: '#d8402c'
  },
  botanico: {
    label: 'Herbario',
    paper: '#f0ece0', ink: '#24301f', mid: '#6d7f56', accent: '#4d6b3a'
  },
  nocturno: {
    label: 'Negativo',
    paper: '#12131a', ink: '#e6e3da', mid: '#8b8fa3', accent: '#c9d4e8'
  },

  /* Las de abajo están pensadas para la lámina de atlas, donde el duotono se
     queda en el fondo y las fotos van a color. Ahí la tinta no tiene que
     tragarse la imagen, solo dibujar el plano por debajo: papel más limpio,
     tinta menos densa y un acento que aguante al lado de una foto en color
     sin pelearse con ella. */
  plano: {
    label: 'Plano (color)',
    paper: '#f6f4ef', ink: '#2f3742', mid: '#78838f', accent: '#41525f'
  },
  topografico: {
    label: 'Topográfico (color)',
    paper: '#f7f5ec', ink: '#3d4a33', mid: '#8a9679', accent: '#5d7048'
  },
  batimetria: {
    label: 'Batimetría (color)',
    paper: '#f2f5f7', ink: '#1f3f55', mid: '#6d93ab', accent: '#2f6f93'
  },
  terracota: {
    label: 'Terracota (color)',
    paper: '#f8f1e7', ink: '#5b3325', mid: '#a9765d', accent: '#8a4a2f'
  }
};
