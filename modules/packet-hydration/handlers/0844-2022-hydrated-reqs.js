const { createHydratedAckHandlers, createMissionTrackingHydratedAckHandler } = require("..");

module.exports = [
  createMissionTrackingHydratedAckHandler(885, "RAID_PLAY"),
  createMissionTrackingHydratedAckHandler(1249, "DIVE_CLEAR"),
  createMissionTrackingHydratedAckHandler(2012, "WORLDMAP_MISSION_CLEAR"),
  ...createHydratedAckHandlers([
    844, 846, 848, 850, 852, 857, 859,
    861, 864, 866, 868, 870, 872, 874, 876,
    878, 880, 882, 887, 889, 1206,
    1208, 1210, 1212, 1215,
    1217, 1219, 1221, 1223, 1225, 1227, 1230, 1232,
    1234, 1236, 1238, 1251,
    1255, 1257, 1259, 1261, 1263, 1265, 1267,
    1269, 1271, 1273, 1275, 1277, 1279, 1281, 1283,
    2000, 2002, 2004, 2006, 2008,
    2010, 2014, 2016, 2018, 2020, 2022,
  ]),
];
